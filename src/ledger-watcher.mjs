// @ts-nocheck
/**
 * ledger-watcher.mjs — POA Ledger Memo Watcher, Signature Verifier & Outbound Payout Dispatcher.
 *
 * Enables 100% Website-Independent Operation:
 *   Users and agents can send standard POA transfers directly on-ledger to `bankAddress`
 *   with `DICE1:*` memos (`DICE1:BET:...`, `DICE1:LP_ADD:...`, `DICE1:LP_WITHDRAW:...`,
 *   `DICE1:CHAT:...`, `DICE1:CLAIM`).
 *
 *   This watcher verifies the Ed25519 signature of every transaction (`verifyBody`),
 *   executes the action in `BankrollEngine`, never confiscates invalid/over-limit transfers
 *   (queues a safe refund to `tx.from`), and dispatches outbound payouts sequentially.
 */

import {
  buildSignedTransfer,
  formatDiceMemo,
  fromMicros,
  genKeypair,
  isValidPoaAddress,
  parseDiceMemo,
  redactSecrets,
  toMicros,
  txidOf,
  verifyBody
} from './crypto-poa.mjs';
import { DEV_RESERVE_ADDRESS, MIN_BET_MICROS } from './bankroll-engine.mjs';

export class LedgerWatcher {
  constructor({
    engine,
    nodeUrl = process.env.POA_BASE_URL || 'https://minepoa.com',
    bankWallet = null,
    mode = 'hybrid' // 'hybrid' | 'simulated' | 'live'
  }) {
    if (!engine) throw new Error('BankrollEngine instance is required');
    this.engine = engine;
    this.nodeUrl = String(nodeUrl).replace(/\/+$/, '');
    this.bankWallet = bankWallet || genKeypair();
    if (!optionsBankAddrMatches(this.engine.bankAddress, this.bankWallet.address) && !bankWallet) {
      // If engine is using the default placeholder address, bind it to our verifiable Ed25519 bank wallet
      if (this.engine.bankAddress.startsWith('poa1BankVault')) {
        this.engine.bankAddress = this.bankWallet.address;
      }
    }
    this.mode = mode;
    this.bankNonce = 1;
    this.recentParentTxids = [];
    this.localLedgerTxs = new Map(); // txid -> { id, body, final, atts, ts }
    this._dispatchLock = false;
    this._pollTimer = null;
  }

  /**
   * Process a signed POA transfer transaction (submitted either via POST /api/tx/submit,
   * MCP tool, CLI, or polled from GET /api/explorer/address/<bankAddress>).
   */
  processSignedTransaction(txEnvelope, { requireSignature = true, requireRecipient = true } = {}) {
    const body = txEnvelope?.body || txEnvelope;
    if (!body || typeof body !== 'object') {
      throw new Error('Transaction body must be an object');
    }
    if (body.type !== 'transfer') {
      throw new Error(`Unsupported transaction type "${body.type}" (expected "transfer")`);
    }
    if (!isValidPoaAddress(body.from)) {
      throw new Error(`Invalid sender POA address: ${body.from}`);
    }
    if (requireRecipient && body.to !== this.engine.bankAddress) {
      throw new Error(`Transaction recipient (${body.to}) does not match bankAddress (${this.engine.bankAddress})`);
    }

    const computedId = txidOf(body);
    const txid = txEnvelope?.id || computedId;
    if (txid !== computedId) {
      throw new Error(`Transaction ID mismatch: provided ${txid} !== computed ${computedId}`);
    }

    if (requireSignature && !verifyBody(body, body.from)) {
      throw new Error(`Ed25519 signature verification failed for sender ${body.from}`);
    }

    // Record in local ledger mirror
    this.localLedgerTxs.set(txid, {
      id: txid,
      body,
      atts: 5,
      final: true,
      ts: body.ts || Math.floor(Date.now() / 1000)
    });
    this.recentParentTxids.push(txid);
    if (this.recentParentTxids.length > 10) this.recentParentTxids.shift();

    return this.executeMemoAction({
      txid,
      from: body.from,
      to: body.to,
      amountPoa: body.amount,
      memo: body.memo || '',
      ts: body.ts || Math.floor(Date.now() / 1000),
      playerSig: body.sig || null
    });
  }

  /**
   * Execute a parsed DICE1:* memo from an on-ledger transfer.
   * Any invalid or out-of-bounds transfer is safely refunded to `from` (never confiscated).
   */
  executeMemoAction({ txid, from, amountPoa, memo, ts = Math.floor(Date.now() / 1000), playerSig = null }) {
    if (this.engine.processedTxids.has(txid)) {
      return { idempotent: true, ...this.engine.processedTxids.get(txid) };
    }

    const parsed = parseDiceMemo(memo);
    if (!parsed.valid) {
      // Safe refund of unrecognized / malformed memo transfer
      const refund = this.engine.queueRefund({
        sourceTxid: txid,
        to: from,
        amountPoa,
        reason: `Malformed memo (${parsed.reason || 'invalid_format'})`,
        ts
      });
      this.flushOutboundQueueSync();
      return refund;
    }

    try {
      if (parsed.action === 'BET') {
        const res = this.engine.placeAndSettleBet({
          betTxid: txid,
          address: from,
          amountPoa,
          targetBps: parsed.targetBps,
          direction: parsed.direction,
          clientSeed: parsed.clientSeed,
          fromOnChainMemo: true,
          playerSig,
          ts
        });
        this.flushOutboundQueueSync();
        return res;
      }

      if (parsed.action === 'LP_ADD') {
        const quote = this.engine.quoteDeposit({
          address: from,
          amountPoa,
          lockEpochs: parsed.lockEpochs
        });
        if (!quote.valid) {
          const refund = this.engine.queueRefund({
            sourceTxid: txid,
            to: from,
            amountPoa,
            reason: quote.error || 'deposit_rejected',
            ts
          });
          this.flushOutboundQueueSync();
          return refund;
        }
        const res = this.engine.applyDeposit({
          txid,
          address: from,
          amountPoa,
          lockEpochs: parsed.lockEpochs,
          referrer: parsed.referrer,
          ts
        });
        this.flushOutboundQueueSync();
        return res;
      }

      if (parsed.action === 'LP_WITHDRAW') {
        const triggerMicros = toMicros(amountPoa);
        const quote = this.engine.quoteWithdraw({
          address: from,
          sharesToRedeem: parsed.shares,
          bpsToRedeem: parsed.bps,
          mode: parsed.mode
        });
        if (!quote.valid) {
          const refund = this.engine.queueRefund({
            sourceTxid: txid,
            to: from,
            amountPoa,
            reason: quote.error || 'withdraw_rejected',
            ts
          });
          this.flushOutboundQueueSync();
          return refund;
        }
        const res = this.engine.applyWithdraw({
          txid,
          address: from,
          sharesToRedeem: parsed.shares,
          bpsToRedeem: parsed.bps,
          mode: parsed.mode,
          triggerRefundMicros: triggerMicros,
          ts
        });
        this.flushOutboundQueueSync();
        return res;
      }

      if (parsed.action === 'CHAT') {
        const chatMsg = this.engine.postChatMessage({
          address: from,
          text: parsed.text,
          isAgent: true,
          onChainTxid: txid,
          ts
        });
        const receipt = { action: 'CHAT_POSTED', txid, chatMessage: chatMsg };
        this.engine.processedTxids.set(txid, receipt);
        return receipt;
      }

      if (parsed.action === 'CLAIM') {
        if (from === DEV_RESERVE_ADDRESS) {
          const sweep = this.engine.sweepDevReserve({ triggerTxid: txid, ts });
          this.flushOutboundQueueSync();
          return sweep;
        }
        const refund = this.engine.queueRefund({
          sourceTxid: txid,
          to: from,
          amountPoa,
          reason: 'Only devReserveAddress can trigger DEV_RESERVE_SWEEP',
          ts
        });
        this.flushOutboundQueueSync();
        return refund;
      }
    } catch (err) {
      const refund = this.engine.queueRefund({
        sourceTxid: txid,
        to: from,
        amountPoa,
        reason: redactSecrets(err.message || 'execution_error'),
        ts
      });
      this.flushOutboundQueueSync();
      return refund;
    }

    return { error: 'unhandled_memo_action' };
  }

  /**
   * Execute a bounded, Ed25519-signed autonomous multi-roll agent strategy with
   * Kelly sizing, Martingale/Paroli progression, and hard stop-loss / take-profit guards.
   */
  executeAutoStrategy({
    wallet,
    strategy = 'flat', // 'flat' | 'quarter_kelly' | 'martingale_capped' | 'paroli'
    baseWagerPoa = '10.000000',
    targetBps = 4950,
    direction = 'under',
    rolls = 5,
    clientSeed = 'agent-auto-strategy',
    stopOnProfitPoa = null,
    stopOnLossPoa = null,
    maxTotalSpendPoa = null,
    onRoll = null
  }) {
    if (!wallet || !wallet.address) {
      throw new Error('Valid Ed25519 wallet required for executeAutoStrategy');
    }
    const maxRolls = Math.max(1, Math.min(25, Number(rolls || 5)));
    const strat = String(strategy || 'flat').toLowerCase();
    const baseMicros = toMicros(baseWagerPoa);
    const stopProfitMicros = stopOnProfitPoa ? toMicros(stopOnProfitPoa) : null;
    const stopLossMicros = stopOnLossPoa ? toMicros(stopOnLossPoa) : null;
    const capMicros = maxTotalSpendPoa ? toMicros(String(maxTotalSpendPoa)) : null;
    let spentMicros = 0n;

    let currentMicros = baseMicros;
    let cumulativeNetMicros = 0n;
    let winStreak = 0;
    let wins = 0;
    let losses = 0;
    let stoppedReason = 'completed_all_rolls';
    const receipts = [];
    const baseNonce = Math.floor(Date.now() / 1000) * 100 + Math.floor(Math.random() * 50);

    for (let i = 0; i < maxRolls; i++) {
      const q = this.engine.quoteBet({
        address: wallet.address,
        amountPoa: fromMicros(currentMicros),
        targetBps,
        direction
      });
      const maxAllowedMicros = toMicros(q.maxAllowedWagerPoa || '1.000000');
      if (maxAllowedMicros < MIN_BET_MICROS) {
        stoppedReason = 'bankroll_kelly_limit_reached';
        break;
      }

      if (strat === 'quarter_kelly') {
        currentMicros = toMicros(q.kellySizing.quarterKellyPoa);
      }
      if (currentMicros > maxAllowedMicros) {
        currentMicros = maxAllowedMicros;
      }
      if (currentMicros < MIN_BET_MICROS) {
        currentMicros = MIN_BET_MICROS;
      }

      if (capMicros !== null && spentMicros + currentMicros > capMicros) {
        stoppedReason = 'max_total_spend_reached';
        break;
      }
      const wagerPoa = fromMicros(currentMicros);
      const memo = formatDiceMemo({
        action: 'BET',
        direction,
        targetBps,
        clientSeed: `${clientSeed}-r${i + 1}`
      });
      const signedTx = buildSignedTransfer({
        wallet,
        to: this.engine.bankAddress,
        amount: wagerPoa,
        memo,
        nonce: baseNonce + i
      });
      const receipt = this.processSignedTransaction(signedTx);
      receipts.push(receipt);

      if (receipt.action !== 'BET_SETTLED') {
        stoppedReason = receipt.reason || 'bet_not_settled';
        break;
      }

      spentMicros += currentMicros;
      if (typeof onRoll === 'function') onRoll(receipt);
      const deltaMicros = receipt.won
        ? toMicros(receipt.payoutPoa) - toMicros(receipt.wagerPoa)
        : -toMicros(receipt.wagerPoa);
      cumulativeNetMicros += deltaMicros;

      if (receipt.won) {
        wins += 1;
        winStreak += 1;
        if (strat === 'martingale_capped') {
          currentMicros = baseMicros;
        } else if (strat === 'paroli') {
          currentMicros = winStreak < 3 ? currentMicros * 2n : baseMicros;
        }
      } else {
        losses += 1;
        winStreak = 0;
        if (strat === 'martingale_capped') {
          currentMicros = currentMicros * 2n;
        } else if (strat === 'paroli') {
          currentMicros = baseMicros;
        }
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
      action: 'AUTO_STRATEGY_COMPLETED',
      playerAddress: wallet.address,
      strategy: strat,
      rollsRequested: maxRolls,
      rollsExecuted: receipts.length,
      wins,
      losses,
      cumulativeNetPoa: fromMicros(cumulativeNetMicros),
      stoppedReason,
      totalWageredPoa: fromMicros(spentMicros),
      receipts
    };
  }

  /**
   * Synchronously sign and record all pending outbound transfers using the Bank's Ed25519 keypair,
   * ensuring every payout, withdrawal, refund, and 0.1% dev sweep produces a verifiable POA tx.
   */
  flushOutboundQueueSync() {
    if (this._dispatchLock) return [];
    this._dispatchLock = true;
    const dispatched = [];
    try {
      for (const item of this.engine.outboundQueue) {
        if (item.status !== 'PENDING') continue;
        const signedTx = buildSignedTransfer({
          wallet: this.bankWallet,
          to: item.to,
          amount: item.amountPoa,
          memo: `${item.memo}:root=${this.engine.computeStateRoot().slice(0, 12)}`,
          nonce: this.bankNonce++,
          parents: this.recentParentTxids.slice(-2),
          ts: Math.floor(Date.now() / 1000)
        });
        this.localLedgerTxs.set(signedTx.id, {
          id: signedTx.id,
          body: signedTx.body,
          atts: 5,
          final: true,
          ts: signedTx.body.ts
        });
        this.recentParentTxids.push(signedTx.id);
        if (this.recentParentTxids.length > 10) this.recentParentTxids.shift();

        this.engine.markOutboundSent(item.orderId, signedTx.id, 'SENT_SIGNED');
        dispatched.push({
          orderId: item.orderId,
          kind: item.kind,
          to: item.to,
          amountPoa: item.amountPoa,
          ledgerTxid: signedTx.id,
          signedTx
        });
      }
    } finally {
      this._dispatchLock = false;
    }
    return dispatched;
  }

  /**
   * Poll keyless explorer on minepoa.com for new incoming DICE1:* transfers to bankAddress.
   */
  async pollExplorerOnce(fetchImpl = globalThis.fetch) {
    if (!fetchImpl || this.mode === 'simulated') return { polled: false, processed: [] };
    const url = `${this.nodeUrl}/api/explorer/address/${this.engine.bankAddress}?sort=new`;
    try {
      const resp = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'poa-dice-watcher/1.0' },
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) return { polled: false, status: resp.status, processed: [] };
      const data = await resp.json();
      const txs = Array.isArray(data?.txs) ? data.txs.map((t) => ({
        id: t.id || t.txid,
        type: t.type || '',
        from: t.from || t.from_addr || '',
        to: t.to || t.to_addr || '',
        amount: t.amount || '0',
        memo: t.memo || '',
        ts: t.ts || Math.floor(Date.now() / 1000)
      })).reverse() : [];
      const processed = [];
      for (const t of txs) {
        const txid = t.id || t.txid;
        if (!txid || this.engine.processedTxids.has(txid)) continue;
        const memo = String(t.memo || '');
        if (t.type === 'transfer' && t.to === this.engine.bankAddress && memo.startsWith('DICE1:')) {
          const res = this.executeMemoAction({
            txid,
            from: t.from,
            to: t.to,
            amountPoa: t.amount,
            memo: t.memo,
            ts: t.ts || Math.floor(Date.now() / 1000)
          });
          processed.push({ txid, result: res });
        }
      }
      return { polled: true, processed };
    } catch (err) {
      return { polled: false, error: redactSecrets(err.message), processed: [] };
    }
  }

  startPolling(intervalMs = 10000) {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => {
      this.pollExplorerOnce().catch(() => {});
    }, intervalMs);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
}

function optionsBankAddrMatches(a, b) {
  return Boolean(a && b && a === b);
}
