// @ts-nocheck
/**
 * chain-settlement.mjs: real minepoa settlement for the vault.
 *
 * Inbound (deposits, bets, withdraw triggers)
 *   - Signed txs from MCP/API are checked, recorded write-ahead, and broadcast with POST /api/submit.
 *   - Nothing is booked until the tx is confirmed on the minepoa ledger (final by default:
 *     K=5 attestations or checkpoint coverage). Booking uses the LEDGER's copy of the body
 *     (from, to, amount, memo), not what the client sent.
 *   - Transfers sent straight to the bank (e.g. `poa.mjs send`) are found by scanning the bank's
 *     explorer page and booked the same way.
 *   - Idempotent by txid: engine.processedTxids + the inbound record.
 *
 * Outbound (payouts, withdrawals, refunds, dev sweeps)
 *   - The engine enqueues orders (deterministic orderId). Settlement adopts them into a durable
 *     queue, signs with the bank key, PERSISTS the signed body (txid) BEFORE broadcasting, then
 *     broadcasts and tracks confirmation: QUEUED -> SIGNED -> SENT -> CONFIRMED (or FAILED).
 *   - Retries rebroadcast the SAME signed body (same txid), so a retry or restart can never pay twice.
 *     A body is only re-signed after the node definitively rejected it AND the explorer
 *     confirms that txid does not exist.
 *   - Strict nonce order: at most one un-acknowledged signed tx at a time.
 *   - Solvency: an order is signed only when the confirmed on-chain bank balance, less
 *     in-flight outbound, covers it. Otherwise it waits (WAITING_FUNDS).
 *
 * Recovery (fix/settlement-recovery)
 *   - The minepoa address page omits memos, so every bank tx's memo is read from
 *     /api/explorer/tx/<id> (or the recent-transfers feed) before deciding whether it is DICE1.
 *   - The ledger is the source of truth: every DICE1 transfer to the bank found on the ledger is
 *     (re)booked once final, idempotent by txid, even if this process lost its state.
 *   - Before signing a payout, the bank's own sent txs on the ledger are indexed by their
 *     `:ord=<orderId12>` memo tag; an order already paid on chain is adopted, never paid again.
 *   - Bank balance = checkpoint balance + final transfers above the checkpoint height (the
 *     explorer's `balance` alone lags until the next checkpoint).
 *   - State (this queue + the engine snapshot) is ONE document in the store, written in order;
 *     a payout is broadcast only after its signed body is durable.
 *
 * Settle exactly once across instances (fix/settle-once-lp-nav)
 *   - Serverless hosts run several instances, each with its own in-memory copy of the document.
 *     Previously each one rolled a bet it booked with ITS OWN nonce/seed, so two instances could
 *     settle the same bet differently (live: stored roll 76.96, payout note roll=93.96).
 *   - Now the seed pair of each epoch is claimed in the store (`seed:<epoch>`, first writer wins,
 *     every instance adopts it), and before a bet is rolled its settlement ticket (nonce, seed epoch,
 *     roll, outcome) is claimed atomically (`bet:<txid>`). Losers adopt the stored ticket, so every
 *     instance books the same result and builds the same payout note from it.
 *   - A payout body is claimed per order + re-sign generation (`payout:<orderId>:<n>`) before it is
 *     broadcast, so two instances can never sign two different transfers for one order.
 *
 * Ledger-first reconciliation (fix/reconcile-onchain-payouts)
 *   - After a state loss, bets found on the ledger that predate the vault state are NEEDS_REVIEW
 *     (never re-rolled). Each tick, for every such bet the bank's own FINAL outbound transfers are
 *     searched for its payout (`DICE1:WIN:<bet16>:roll=..`) or refund (`DICE1:REFUND:<bet16>:..`), memos
 *     read per tx. A found payout settles the bet with the on-chain amount and the memo's roll (an
 *     unverified claim), with the normal win-path bankroll effects (house P&L, dev fee, pool fee).
 *     Nothing is paid again. Without a payout the bet stays in review.
 *   - Every other FINAL bank outflow that matches no order, no recovered bet and no in-flight tx is
 *     booked as a recovered outflow, so the internal books reconcile to the chain.
 *   - Each decision is claimed in the store (`reconcile:<txid>`), so all instances book the same thing,
 *     and the engine is idempotent by txid.
 *   - Trading hold: until a reconcile pass has completed AND the books are covered by the confirmed
 *     on-chain balance, new bets and withdrawals are refused (and deferred if they arrive on the
 *     ledger directly), and quotes for them are not valid. Deposits stay open.
 */
import { buildSignedTransfer, fromMicros, isValidPoaAddress, parseDiceMemo, toMicros, txidOf, verifyBody } from './crypto-poa.mjs';
import { PersistQueue } from './settlement-store.mjs';
import { isLedgerOutage, LEDGER_HOLD } from './ledger-probe.mjs';

const TERMINAL_OUT = new Set(['CONFIRMED', 'FAILED']);
const OPEN_IN = new Set(['SUBMITTING', 'BROADCAST', 'SEEN']);
const HOLD_ACTIONS = new Set(['BET', 'LP_WITHDRAW', 'WITHDRAW', 'CLAIM']);

/** Public trading state: OPEN, HOLD (reconciling / solvency) or PAUSED_LEDGER_UNAVAILABLE. */
export function tradingLabel(hold) {
  if (!hold) return 'OPEN';
  return hold.status === LEDGER_HOLD ? 'PAUSED_LEDGER_UNAVAILABLE' : 'HOLD';
}

function now() {
  return Date.now();
}

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export class ChainSettlement {
  constructor({
    engine,
    watcher,
    client,
    bankWallet,
    store,
    confirmPolicy = 'final',
    backoffBaseMs = 2000,
    backoffMaxMs = 5 * 60 * 1000,
    maxResign = 3,
    inboundExpireMs = 30 * 60 * 1000,
    balanceStaleMs = 60 * 1000,
    ledgerProbe = null,
    logger = null
  }) {
    if (!bankWallet || !bankWallet.address) throw new Error('ChainSettlement needs the bank wallet');
    this.engine = engine;
    this.watcher = watcher;
    this.client = client;
    Object.defineProperty(this, 'bankWallet', { value: bankWallet, enumerable: false });
    this.bankAddress = bankWallet.address;
    this.store = store;
    this.confirmPolicy = confirmPolicy;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.maxResign = maxResign;
    this.inboundExpireMs = inboundExpireMs;
    this.balanceStaleMs = balanceStaleMs;
    this._lastRow = null;
    this._lastRowAt = 0;
    this.logger = logger;
    // minepoa writability (see ledger-probe.mjs): when it cannot accept txs, trading pauses (LEDGER_UNAVAILABLE).
    this.ledgerProbe = ledgerProbe;
    if (ledgerProbe && !ledgerProbe.onChange) ledgerProbe.onChange = (view) => this._emit('ledger.status', view);
    this._tickPromise = null;
    this._tickErrors = [];
    this._timer = null;
    this._nonceCache = new Map();
    this.lastTick = null;
    this.lastError = null;
    this.lastBankBalance = null;

    this._persist = new PersistQueue(store);
    this._loaded = false;
    this.fatalError = null;
    this.ledgerIndexComplete = false;
    this.reconcile = { status: 'PENDING', reason: 'Reconciling the vault with the minepoa ledger (first pass not finished yet)', at: null, inReview: [], recovered: 0, audit: null };
    this.state = { version: 1, bankAddress: this.bankAddress, bankNonce: null, inbound: {}, outbound: {}, groups: {}, ledgerOut: {}, seq: 0, createdAt: Math.floor(now() / 1000) };
    const loaded = store.load();
    if (loaded && typeof loaded.then === 'function') {
      this._loadPromise = loaded.then(
        (doc) => this._applyDoc(doc),
        (err) => {
          this.fatalError = `Could not load vault state from ${store.kind}: ${err.message}`;
          throw new Error(this.fatalError);
        }
      );
      this._loadPromise.catch(() => {});
    } else {
      this._applyDoc(loaded);
      this._loadPromise = Promise.resolve();
    }
  }

  /** Resolves once state is loaded from the store (async for KV stores). */
  ready() {
    return this._loadPromise;
  }

  _applyDoc(doc) {
    if (doc && doc.version === 1) {
      this.state = doc;
      if (this.state.createdAt === undefined) this.state.createdAt = 0; // pre-recovery doc: age unknown
    }
    this.state.ledgerOut = this.state.ledgerOut || {};
    if (this.state.bankAddress && this.state.bankAddress !== this.bankAddress) {
      this.fatalError = `Settlement store belongs to bank ${this.state.bankAddress}, not ${this.bankAddress}`;
      throw new Error(this.fatalError);
    }
    this.state.bankAddress = this.bankAddress;
    // The engine snapshot travels in the same document, so queue and books can never disagree.
    if (doc && doc.engine) {
      if (doc.engine.bankAddress && doc.engine.bankAddress !== this.bankAddress && !String(doc.engine.bankAddress).startsWith('poa1BankVault')) {
        this.fatalError = `Stored vault state belongs to bank ${doc.engine.bankAddress}, not ${this.bankAddress}`;
        throw new Error(this.fatalError);
      }
      this.engine.restoreState(doc.engine);
      this.engine.bankAddress = this.bankAddress;
    }
    // A crash mid-broadcast leaves SUBMITTING: treat as broadcast; it is booked if the ledger has it,
    // and expires (releasing its reservation) if it never shows up.
    for (const rec of Object.values(this.state.inbound)) if (rec.status === 'SUBMITTING') rec.status = 'BROADCAST';
    // Restore pending-bet reservations after a restart, so the bank cannot be oversubscribed.
    const held = new Map();
    for (const rec of Object.values(this.state.inbound)) {
      if (OPEN_IN.has(rec.status) && rec.reserve) held.set(rec.reserve.key, (held.get(rec.reserve.key) || 0n) + BigInt(rec.reserve.micros));
    }
    for (const [key, micros] of held) {
      try {
        this.engine.batchReservations.set(key, micros);
        this.engine.lockedCollateralMicros += micros;
      } catch {
        // ignore
      }
    }
    this._loaded = true;
    this.engine.onStateSaved = () => this._save();
    this._save();
  }

  _save() {
    if (!this._loaded) return; // never overwrite stored state with a pre-load blank
    this.state.engine = this.engine.serializeState();
    this.state.savedAt = now();
    this._persist.save(this.state);
  }

  /** Wait until everything saved so far is durable (KV stores write asynchronously). */
  flush() {
    return this._persist.flush();
  }

  _emit(type, payload) {
    try {
      this.engine._emit(type, payload);
    } catch {
      // ignore
    }
  }

  _confirmed(tx) {
    if (!tx || tx.invalid) return false;
    return this.confirmPolicy === 'included' ? true : tx.final;
  }

  // ─── Inbound ──────────────────────────────────────────────────────────────

  /** Build + sign a player transfer with a chain-correct nonce/parents (privkey path). */
  async buildSignedFor(wallet, { amount, memo }) {
    const cached = this._nonceCache.get(wallet.address);
    let nonce;
    if (cached && now() - cached.at < 60000) nonce = cached.next;
    else nonce = await this.client.nextNonce(wallet.address);
    const parents = await this._parents();
    const tx = buildSignedTransfer({ wallet, to: this.bankAddress, amount, memo, nonce, parents, cid: this.client.chainId });
    this._nonceCache.set(wallet.address, { next: nonce + 1, at: now() });
    return tx;
  }

  async _parents() {
    if (this._tip && now() - this._tip.at < 5000) return this._tip.ids;
    const ids = await this.client.getTipParents();
    this._tip = { ids, at: now() };
    return ids;
  }

  _validateInbound(txEnvelope) {
    const body = txEnvelope?.body || txEnvelope;
    if (!body || typeof body !== 'object') throw bad('Transaction body must be an object');
    if (body.type !== 'transfer') throw bad(`Unsupported transaction type "${body.type}" (expected "transfer")`);
    if (!isValidPoaAddress(body.from)) throw bad('Invalid sender address');
    if (body.to !== this.bankAddress) throw bad(`Transaction recipient (${body.to}) is not the bank (${this.bankAddress})`);
    const txid = txidOf(body);
    if (txEnvelope?.id && txEnvelope.id !== txid) throw bad('Transaction ID mismatch');
    if (!verifyBody(body, body.from)) throw bad('Ed25519 signature verification failed');
    const parsed = parseDiceMemo(body.memo || '');
    if (!parsed.valid) throw bad(`Memo is not a valid DICE1 action (${parsed.reason || 'invalid'}); not broadcast`);
    try {
      if (toMicros(body.amount) <= 0n) throw new Error('x');
    } catch {
      throw bad('Amount must be positive');
    }
    return { body, txid, parsed };
  }

  /**
   * Broadcast a player-signed tx and track it until it is confirmed and booked.
   * opts.reserve = {key, micros}: bank exposure held for this tx until it settles.
   * opts.groupId: batch id (batch.completed fires once every member resolves).
   */
  async submitInbound(txEnvelope, { reserve = null, groupId = null, coverage = null } = {}) {
    await this.ready();
    const { body, txid, parsed } = this._validateInbound(txEnvelope);
    // Ledger can't accept transactions: refuse every NEW broadcast (bets, stakes, withdrawals, chat) up front.
    if (this.ledgerProbe && !this.state.inbound[txid] && !this.engine.processedTxids.has(txid)) {
      await this.ledgerProbe.maybeProbe().catch(() => {});
      const lh = this.ledgerProbe.hold();
      if (lh) throw Object.assign(new Error(`${lh.reason} Not broadcast; nothing was booked.`), { status: 503, code: LEDGER_HOLD, txid });
    }
    const hold = HOLD_ACTIONS.has(parsed.action) && !this.state.inbound[txid] ? await this.ensureReconciled() : null;
    if (hold) {
      throw Object.assign(new Error(`${hold.reason} Not broadcast; try again shortly.`), { status: 503, code: hold.status, txid });
    }
    const existing = this.state.inbound[txid];
    if (existing && existing.status !== 'FAILED' && existing.status !== 'EXPIRED') return this._inboundView(existing, { duplicate: true });
    if (this.engine.processedTxids.has(txid)) return { txid, status: 'BOOKED', duplicate: true, result: this.engine.processedTxids.get(txid) };

    // Bank coverage: a bet is broadcast only after its worst-case payout is reserved against the
    // bank's real free funds (atomic across instances). Batches pre-reserve their combined worst case.
    let cov = coverage;
    if (parsed.action === 'BET' && !cov) {
      const q = this.engine.quoteBet({ address: body.from, amountPoa: body.amount, targetBps: parsed.targetBps, direction: parsed.direction });
      if (!q.payoutOnWinMicros) throw Object.assign(new Error(q.error || 'Bet outside allowed limits'), { status: 400, code: 'BET_LIMITS', quote: q });
      await this.reserveBetCoverage(txid, BigInt(q.payoutOnWinMicros));
      cov = { key: txid, micros: String(q.payoutOnWinMicros) };
    }
    const rec = {
      txid,
      seq: ++this.state.seq,
      from: body.from,
      amountPoa: body.amount,
      memo: body.memo,
      action: parsed.action,
      status: 'SUBMITTING',
      submittedAt: now(),
      reserve,
      coverage: cov ? { key: cov.key, micros: String(cov.micros) } : null,
      groupId,
      attempts: 0,
      error: null,
      result: null,
      ledger: null
    };
    this.state.inbound[txid] = rec;
    this._save();
    try {
      await this.flush();
    } catch (err) {
      delete this.state.inbound[txid];
      this._releaseCoverage(rec);
      throw Object.assign(new Error(`Vault store unavailable; not broadcast: ${err.message}`), { status: 503, txid });
    }

    try {
      rec.attempts += 1;
      const resp = await this.client.submitTx(body);
      if (resp && Number.isInteger(Number(resp.next_nonce))) this._nonceCache.set(body.from, { next: Number(resp.next_nonce), at: now() });
      rec.status = 'BROADCAST';
    } catch (err) {
      this.ledgerProbe?.reportFailure('player broadcast', err);
      // The node may have taken it anyway (e.g. timeout after accept): ask the explorer.
      const seen = await this.client.getTx(txid).catch(() => null);
      if (seen) {
        rec.status = 'BROADCAST';
      } else {
        rec.status = 'FAILED';
        rec.error = String(err.message || err);
        this._nonceCache.delete(body.from);
        this._releaseReserve(rec);
        this._releaseCoverage(rec);
        this._resolveGroup(rec);
        this._save();
        this._emit('settlement.updated', this._inboundView(rec));
        throw Object.assign(new Error(`Broadcast to minepoa failed; nothing was booked: ${rec.error}`), { status: 502, txid });
      }
    }
    this._save();
    this._emit('settlement.updated', this._inboundView(rec));
    this.kick();
    return this._inboundView(rec);
  }

  _releaseReserve(rec) {
    if (!rec.reserve) return;
    this.engine.releaseExposure(rec.reserve.key, BigInt(rec.reserve.micros));
    rec.reserve = null;
  }

  _resolveGroup(rec) {
    if (!rec.groupId) return;
    const g = this.state.groups[rec.groupId];
    if (!g) return;
    g.resolved += 1;
    const r = rec.result;
    if (r && r.action === 'BET_SETTLED') {
      g.done += 1;
      if (r.won) g.wins += 1;
      else g.losses += 1;
      g.netMicros = (BigInt(g.netMicros) + (r.won ? toMicros(r.payoutPoa) : 0n) - toMicros(r.wagerPoa)).toString();
    }
    if (g.resolved >= g.count && !g.completed) {
      g.completed = true;
      this._emit('batch.completed', {
        batchId: rec.groupId,
        address: g.address,
        count: g.count,
        done: g.done,
        wins: g.wins,
        losses: g.losses,
        netPoa: (BigInt(g.netMicros) < 0n ? '-' : '') + fromMicros(BigInt(g.netMicros) < 0n ? -BigInt(g.netMicros) : BigInt(g.netMicros)),
        stoppedReason: g.done === g.count ? 'completed_all_rolls' : 'some_rolls_not_settled',
        settlement: 'chain'
      });
    } else if (r && r.action === 'BET_SETTLED') {
      this._emit('batch.progress', { batchId: rec.groupId, address: g.address, count: g.count, done: g.done, wins: g.wins, losses: g.losses });
    }
  }

  openGroup(groupId, { count, address }) {
    this.state.groups[groupId] = { count, address, resolved: 0, done: 0, wins: 0, losses: 0, netMicros: '0', completed: false, createdAt: now() };
    this._save();
  }

  _inboundView(rec, extra = {}) {
    const payouts = Object.values(this.state.outbound)
      .filter((o) => o.sourceTxid === rec.txid)
      .map((o) => this._outboundView(o));
    return {
      direction: 'inbound',
      txid: rec.txid,
      status: rec.status === 'BOOKED' ? 'CONFIRMED' : rec.status === 'BROADCAST' || rec.status === 'SEEN' ? 'PENDING_CONFIRMATION' : rec.status,
      rawStatus: rec.status,
      action: rec.action,
      from: rec.from,
      amountPoa: rec.amountPoa,
      explorer: this.client.explorerTxUrl(rec.txid),
      result: rec.result,
      error: rec.error,
      payouts,
      ...extra
    };
  }

  async _confirmInbound() {
    for (const rec of Object.values(this.state.inbound).sort((a, b) => a.seq - b.seq)) {
      if (!OPEN_IN.has(rec.status) || rec.status === 'SUBMITTING') continue;
      let tx;
      try {
        tx = await this.client.getTx(rec.txid);
      } catch (err) {
        this._tickErrors.push(err.message);
        return; // node unreachable: try next tick
      }
      if (!tx) {
        if (now() - rec.submittedAt > this.inboundExpireMs) {
          rec.status = 'EXPIRED';
          rec.error = 'Not seen on the minepoa ledger in time; nothing was booked';
          this._releaseReserve(rec);
          this._releaseCoverage(rec);
          this._resolveGroup(rec);
          this._save();
          this._emit('settlement.updated', this._inboundView(rec));
        }
        continue;
      }
      if (tx.invalid) {
        rec.status = 'FAILED';
        rec.error = 'minepoa marked the tx invalid; nothing was booked';
        this._releaseReserve(rec);
        this._releaseCoverage(rec);
        this._resolveGroup(rec);
        this._save();
        this._emit('settlement.updated', this._inboundView(rec));
        continue;
      }
      if (!this._confirmed(tx)) {
        rec.ledger = { atts: tx.atts, final: tx.final };
        continue;
      }
      const booked = await this._book(rec, tx);
      if (booked === false) return; // store unreachable: retry next tick, in order
    }
  }

  /** Make every instance use the same committed seed pair for the active epoch. */
  async _syncSeed() {
    const epoch = this.engine.seedManager.epochId;
    if (this._seedSyncedEpoch === epoch && this._seedSyncedSeed === this.engine.seedManager.currentSeed) return true;
    let res;
    try {
      res = await this._persist.claim(`seed:${epoch}`, this.engine.seedRecord());
    } catch (err) {
      this._tickErrors.push(`store claim (seed): ${err.message}`);
      return false;
    }
    if (!res.claimed && this.engine.adoptSeedRecord(res.value)) {
      if (this.logger) this.logger(`adopted committed seed for epoch ${epoch} from the shared store`);
      this._save();
    }
    this._seedSyncedEpoch = epoch;
    this._seedSyncedSeed = this.engine.seedManager.currentSeed;
    return true;
  }

  /**
   * Claim the settlement ticket for a ledger-confirmed bet. Returns the authoritative ticket
   * (ours or the one another instance claimed first), or null when the store is unreachable.
   */
  async _claimBetTicket(rec, b) {
    const parsed = parseDiceMemo(b.memo || '');
    if (!parsed.valid || parsed.action !== 'BET') return undefined; // refund path: no roll
    if (!(await this._syncSeed())) return null;
    const mine = this.engine.prepareBetTicket({
      betTxid: rec.txid,
      address: b.from,
      clientSeed: parsed.clientSeed,
      targetBps: parsed.targetBps,
      direction: parsed.direction
    });
    try {
      const res = await this._persist.claim(`bet:${rec.txid}`, mine);
      if (!res.claimed && res.value && res.value.rollBps !== mine.rollBps && this.logger) {
        this.logger(`bet ${rec.txid.slice(0, 16)} already settled by another instance; adopting its roll ${res.value.rollDisplay}`);
      }
      return res.value;
    } catch (err) {
      this._tickErrors.push(`store claim (bet): ${err.message}`);
      return null;
    }
  }

  async _book(rec, tx) {
    const b = tx.body && tx.body.from ? tx.body : { from: tx.from, to: tx.to, amount: tx.amount, memo: tx.memo, ts: tx.ts, type: 'transfer' };
    const mismatch =
      (b.type && b.type !== 'transfer') ||
      b.to !== this.bankAddress ||
      (rec.from && b.from !== rec.from) ||
      (rec.amountPoa && toMicros(b.amount) !== toMicros(rec.amountPoa)) ||
      (rec.memo !== undefined && rec.memo !== null && String(b.memo || '') !== String(rec.memo));
    if (mismatch) {
      rec.status = 'FAILED';
      rec.error = 'Ledger copy of the tx does not match what was submitted; not booked';
      this._releaseReserve(rec);
      this._releaseCoverage(rec);
      this._resolveGroup(rec);
      this._save();
      return;
    }
    this._releaseReserve(rec);
    // A bet older than this vault state means the state was lost after it was (probably) settled.
    // Re-rolling it with a new seed could pay an outcome that never happened, so hold it for review.
    // Deposits, withdrawals and chat replay safely (payouts are de-duplicated by their ledger order tag).
    // "Replay" = the tx predates this vault state OR the bank already paid something that references it
    // on chain (ledger-first: the ledger, not a timestamp, says it was processed before the state loss).
    const predates = Boolean(this.state.createdAt && Number(b.ts || 0) < this.state.createdAt);
    const replay = rec.discoveredBy === 'ledger-scan' && (predates || this._outflowRefs().has(rec.txid.slice(0, 16)));
    if (replay && rec.action === 'BET' && !this.engine.processedTxids.has(rec.txid)) {
      rec.status = 'NEEDS_REVIEW';
      rec.ledger = { atts: tx.atts, final: tx.final };
      rec.error = 'Bet predates this vault state (state was lost); not re-rolled. It is settled from its on-chain payout if one exists, otherwise it stays in review.';
      this._save();
      this._emit('settlement.updated', this._inboundView(rec));
      return;
    }
    // Trading hold: a NEW bet / withdrawal waits (stays open, booked later) until the books reconcile.
    if (this.tradingHold() && !replay && HOLD_ACTIONS.has(rec.action) && !this.engine.processedTxids.has(rec.txid)) {
      rec.ledger = { atts: tx.atts, final: tx.final };
      rec.heldBy = this.tradingHold()?.status || this.reconcile.status;
      return true;
    }
    let result;
    if (!this.engine.processedTxids.has(rec.txid) && rec.action === 'BET' && !rec.coverage) {
      // A bet that arrived straight on the ledger (no reservation yet): reserve its worst case now.
      const parsedBet = parseDiceMemo(b.memo || '');
      const q = parsedBet.valid ? this.engine.quoteBet({ address: b.from, amountPoa: b.amount, targetBps: parsedBet.targetBps, direction: parsedBet.direction }) : null;
      if (q && q.valid) {
        const cov = await this.betCoverage(BigInt(q.payoutOnWinMicros), { reserveKey: rec.txid });
        if (cov.unknown) {
          // Fail closed: bank balance unknown/stale or books not reconciled -> HOLD (not rolled, not
          // refunded); it is booked on a later tick once the balance is known again.
          rec.ledger = { atts: tx.atts, final: tx.final };
          rec.heldBy = cov.code;
          rec.error = `Held: ${cov.reason}`;
          return true;
        }
        if (!cov.ok) {
          // Known balance, cannot cover: REFUND the full wager (no dust deducted); never rolled.
          result = this.engine.queueRefund({ sourceTxid: rec.txid, to: b.from, amountPoa: b.amount, reason: `bank cannot cover worst-case payout ${q.payoutOnWinPoa} POA`, full: true, ts: b.ts || Math.floor(now() / 1000) });
          this.watcher.flushOutboundQueueSync?.();
        } else {
          rec.coverage = { key: rec.txid, micros: String(q.payoutOnWinMicros) };
        }
      }
    }
    if (result) {
      // refunded above
    } else if (this.engine.processedTxids.has(rec.txid)) {
      result = this.engine.processedTxids.get(rec.txid);
    } else {
      const ticket = await this._claimBetTicket(rec, b);
      if (ticket === null) return false;
      if (this.engine.processedTxids.has(rec.txid)) {
        result = this.engine.processedTxids.get(rec.txid);
      } else {
      if (ticket) this.engine.settlementTickets.set(rec.txid, ticket);
      try {
      result = this.watcher.executeMemoAction({
        txid: rec.txid,
        from: b.from,
        to: b.to,
        amountPoa: b.amount,
        memo: b.memo || '',
        ts: b.ts || Math.floor(now() / 1000),
        playerSig: b.sig || null
      });
      } finally {
        this.engine.settlementTickets.delete(rec.txid);
      }
      }
    }
    rec.status = 'BOOKED';
    rec.bookedAt = now();
    rec.ledger = { atts: tx.atts, final: tx.final };
    rec.result = result
      ? {
          action: result.action,
          won: result.won,
          rollDisplay: result.rollDisplay,
          wagerPoa: result.wagerPoa,
          payoutPoa: result.payoutPoa,
          sharesMinted: result.sharesMinted,
          netPayoutPoa: result.netPayoutPoa,
          reason: result.reason
        }
      : null;
    this._resolveGroup(rec);
    this._save();
    this._releaseCoverage(rec); // settled: its payout (if any) is now a queued order counted as pending
    this._emit('settlement.updated', this._inboundView(rec));
  }

  /**
   * Read the bank's ledger view: discover DICE1 transfers to the bank (memo looked up per tx,
   * because the address page omits it), index the bank's own sent txs by order tag, and compute
   * the real spendable balance (checkpoint balance + final transfers above the checkpoint).
   * Returns the row with .effectiveMicros (null when it cannot be trusted this tick).
   */
  async _scanBank() {
    let row;
    try {
      row = await this.client.getAddress(this.bankAddress);
    } catch (err) {
      this._tickErrors.push(err.message);
      this._lastRow = null; // unknown balance: bets fail closed until the next good read
      return null;
    }
    // Recent-transfer feed: optional, only saves memo lookups (its window is small and shifts).
    let recent = null;
    try {
      recent = await this.client.getRecentTransfers(200);
    } catch {
      recent = null;
    }

    // Union of what the address page and the recent feed know about the bank.
    const byId = new Map();
    for (const t of row.txs || []) if (t && t.id && t.type === 'transfer') byId.set(t.id, { ...t });
    if (recent) {
      for (const r of recent.values()) {
        if (r.to !== this.bankAddress && r.from !== this.bankAddress) continue;
        const prev = byId.get(r.id) || {};
        byId.set(r.id, { ...r, ...prev, memo: r.memo, memoKnown: true, final: prev.final || r.final });
      }
    }
    const txs = [...byId.values()].sort((x, y) => (x.height ?? 0) - (y.height ?? 0) || (x.ts || 0) - (y.ts || 0));

    let outIndexComplete = true;
    for (const t of txs) {
      if (t.to === this.bankAddress && t.from !== this.bankAddress) {
        if (this.state.inbound[t.id] || this.engine.processedTxids.has(t.id)) continue;
        let memo = t.memoKnown ? String(t.memo || '') : undefined;
        if (memo === undefined) {
          try {
            memo = await this.client.getMemo(t.id);
          } catch (err) {
            this._tickErrors.push(`memo ${t.id.slice(0, 12)}: ${err.message}`);
            outIndexComplete = false; // an unindexed inbound could be what an outflow pays: don't reconcile yet
            continue; // retried next tick
          }
        }
        if (memo === null || !String(memo).startsWith('DICE1:')) continue; // plain donation / unknown
        this.state.inbound[t.id] = {
          txid: t.id,
          seq: ++this.state.seq,
          from: t.from,
          amountPoa: t.amount,
          memo,
          action: parseDiceMemo(memo).action || null,
          status: 'SEEN',
          submittedAt: now(),
          ledgerTs: t.ts || null,
          discoveredBy: 'ledger-scan',
          reserve: null,
          groupId: null,
          attempts: 0,
          error: null,
          result: null,
          ledger: null
        };
        this._save();
      } else if (t.from === this.bankAddress) {
        if (this.state.ledgerOut[t.id]) {
          if (t.final && !this.state.ledgerOut[t.id].final) {
            this.state.ledgerOut[t.id].final = true;
            this._save();
          }
          continue;
        }
        let memo = t.memoKnown ? String(t.memo || '') : undefined;
        if (memo === undefined) {
          try {
            memo = await this.client.getMemo(t.id);
          } catch (err) {
            this._tickErrors.push(`memo ${t.id.slice(0, 12)}: ${err.message}`);
            outIndexComplete = false;
            continue;
          }
        }
        if (memo === null) {
          outIndexComplete = false;
          continue;
        }
        const m = /:ord=([0-9a-f]{12})/.exec(String(memo));
        this.state.ledgerOut[t.id] = { ord: m ? m[1] : null, to: t.to, amountPoa: t.amount, memo: String(memo).slice(0, 200), final: Boolean(t.final), ts: t.ts || null };
        this._save();
      }
    }
    // Our own SIGNED/SENT txs may not be listed yet; they are covered by _inFlightOutMicros.
    this.ledgerIndexComplete = outIndexComplete;

    // Real spendable balance. minepoa's `balance` is as of the last checkpoint and the explorer
    // gives no per-tx height on the address page, so take the larger of two LOWER bounds:
    //   est1 = sum(final transfers in) - sum(transfers out) over the listed history
    //          (exact for a bank created after the 2026-10-24 genesis cut: the listing is its whole history)
    //   est2 = checkpoint balance - sum(listed transfers out)   (as if no outbound were covered yet)
    // Our own signed/sent payouts that are not listed yet are subtracted later (_inFlightOutMicros).
    let checkpointMicros = null;
    try {
      checkpointMicros = toMicros(row.balance || '0');
    } catch {
      checkpointMicros = null;
    }
    const listed = new Set();
    let finalIn = 0n;
    let outAll = 0n;
    for (const t of txs) {
      if (t.to === this.bankAddress && t.from === this.bankAddress) continue;
      if (t.to === this.bankAddress) {
        listed.add(t.id);
        if (t.final) finalIn += toMicros(t.amount || '0');
      } else if (t.from === this.bankAddress) {
        listed.add(t.id);
        outAll += toMicros(t.amount || '0');
      }
    }
    const est1 = finalIn - outAll;
    const est2 = checkpointMicros === null ? null : checkpointMicros - outAll;
    const effective = est2 === null ? est1 : est1 > est2 ? est1 : est2;
    row.effectiveMicros = effective;
    row.listedIds = listed;
    this.lastBankBalance = {
      balance: fromMicros(effective < 0n ? 0n : effective),
      checkpointBalance: row.balance,
      checkpointHeight: row.checkpoint == null ? null : Number(row.checkpoint),
      ledgerFinalInPoa: fromMicros(finalIn),
      ledgerOutPoa: fromMicros(outAll),
      source: est2 !== null && est2 >= est1 ? 'checkpoint-minus-outbound' : 'ledger-history-final',
      at: now()
    };
    this._lastRow = outIndexComplete ? row : null;
    this._lastRowAt = now();
    return row;
  }

  _scanBankReadOnly() {
    return this._scanBank();
  }

  /** Ledger lookup for a txid the vault has no record of (status endpoint fallback). */
  async lookupLedger(txid) {
    if (!/^[0-9a-f]{64}$/.test(String(txid))) return null;
    const tx = await this.client.getTx(txid).catch(() => undefined);
    if (tx === undefined) return { txid, status: 'UNKNOWN', rawStatus: 'LEDGER_UNREACHABLE', note: 'minepoa did not answer; try again' };
    if (!tx || tx.to !== this.bankAddress) return null;
    const memo = String(tx.memo || '');
    this.kick();
    return {
      direction: 'inbound',
      txid,
      status: memo.startsWith('DICE1:') ? (tx.final ? 'CONFIRMED_ON_LEDGER_BOOKING' : 'PENDING_CONFIRMATION') : 'NOT_A_DICE_ACTION',
      rawStatus: 'LEDGER_ONLY',
      from: tx.from,
      amountPoa: tx.amount,
      memo,
      ledger: { atts: tx.atts, final: tx.final },
      explorer: this.client.explorerTxUrl(txid),
      note: memo.startsWith('DICE1:') ? 'Found on the minepoa ledger. The vault books it on its next scan (idempotent by txid).' : 'Transfer to the bank without a DICE1 memo; not a game action.'
    };
  }

  // ─── Outbound ─────────────────────────────────────────────────────────────

  _adoptOutbound() {
    let adopted = 0;
    for (const item of this.engine.outboundQueue) {
      if (item.status !== 'PENDING') continue;
      if (!this.state.outbound[item.orderId]) {
        this.state.outbound[item.orderId] = {
          orderId: item.orderId,
          seq: ++this.state.seq,
          sourceTxid: item.sourceTxid,
          kind: item.kind,
          to: item.to,
          amountPoa: item.amountPoa,
          memo: `${item.memo}:ord=${item.orderId.slice(0, 12)}`.slice(0, 500),
          status: 'QUEUED',
          txid: null,
          body: null,
          nonce: null,
          attempts: 0,
          resigns: 0,
          nextAttemptAt: 0,
          lastError: null,
          superseded: [],
          createdAt: now()
        };
        adopted += 1;
      }
    }
    if (adopted) this._save(); // durable BEFORE the engine forgets it is pending
    for (const item of this.engine.outboundQueue) {
      if (item.status === 'PENDING' && this.state.outbound[item.orderId]) item.status = 'IN_SETTLEMENT';
    }
    if (adopted) this.engine._saveToDisk();
    return adopted;
  }

  /**
   * Payouts not yet reflected in the ledger view. With listedIds (from the last scan), anything of
   * ours that is signed/sent/confirmed but not listed is counted; listed ones are already in the balance.
   */
  _inFlightOutMicros(listedIds = null) {
    let s = 0n;
    for (const o of Object.values(this.state.outbound)) {
      const counts = o.status === 'SIGNED' || o.status === 'SENT' || (listedIds && o.status === 'CONFIRMED' && !o.recoveredFromLedger);
      if (!counts) continue;
      if (listedIds && o.txid && listedIds.has(o.txid)) continue;
      s += toMicros(o.amountPoa);
    }
    return s;
  }

  _unconfirmedInMicros() {
    let s = 0n;
    for (const r of Object.values(this.state.inbound)) {
      if (r.status === 'BROADCAST' || r.status === 'SEEN') s += toMicros(r.amountPoa);
    }
    return s;
  }

  _backoff(attempts) {
    const base = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, attempts - 1));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  async _broadcastSigned(rec) {
    // Never pay twice: if this exact txid is already known to the node, it is sent.
    const known = await this.client.getTx(rec.txid).catch(() => undefined);
    if (known === undefined) {
      rec.nextAttemptAt = now() + this._backoff(++rec.attempts);
      rec.lastError = 'minepoa unreachable';
      return false;
    }
    if (known) return this._markSent(rec, {});
    try {
      rec.attempts += 1;
      const resp = await this.client.submitTx(rec.body);
      return this._markSent(rec, resp || {});
    } catch (err) {
      rec.lastError = String(err.message || err);
      // Stays queued and retries with backoff (same signed body, same txid: never paid twice).
      this.ledgerProbe?.reportFailure('payout broadcast', err);
      if (err.definitive) {
        const again = await this.client.getTx(rec.txid).catch(() => undefined);
        if (again) return this._markSent(rec, {});
        if (again === null) {
          // The node refused this body and it is not on the ledger: safe to re-sign with fresh nonce/parents.
          rec.superseded.push({ txid: rec.txid, nonce: rec.nonce, error: rec.lastError });
          rec.resigns += 1;
          this.state.bankNonce = null;
          this._tip = null; // fetch fresh parents too
          rec.txid = null;
          rec.body = null;
          rec.nonce = null;
          rec.status = rec.resigns > this.maxResign ? 'FAILED' : 'QUEUED';
          rec.nextAttemptAt = now() + this._backoff(rec.resigns);
          if (rec.status === 'FAILED') this._failEngine(rec);
          this._save();
          this._emit('settlement.updated', this._outboundView(rec));
          return false;
        }
      }
      rec.nextAttemptAt = now() + this._backoff(rec.attempts);
      this._save();
      this._emit('settlement.updated', this._outboundView(rec));
      return false;
    }
  }

  _markSent(rec, resp) {
    rec.status = 'SENT';
    rec.sentAt = now();
    rec.lastError = null;
    const next = Number(resp.next_nonce);
    this.state.bankNonce = Number.isInteger(next) && next > rec.nonce ? next : rec.nonce + 1;
    this._save();
    this.engine.markOutboundSent(rec.orderId, rec.txid, 'SENT');
    this._emit('settlement.updated', this._outboundView(rec));
    return true;
  }

  _failEngine(rec) {
    const item = this.engine.outboundQueue.find((x) => x.orderId === rec.orderId);
    if (item) {
      item.status = 'FAILED';
      this.engine._saveToDisk();
    }
  }

  async _processOutbound(bankRow) {
    const recs = Object.values(this.state.outbound).sort((a, b) => a.seq - b.seq);
    // 1. confirmations
    for (const rec of recs) {
      if (rec.status !== 'SENT') continue;
      const tx = await this.client.getTx(rec.txid).catch(() => undefined);
      if (tx && this._confirmed(tx)) {
        rec.status = 'CONFIRMED';
        rec.confirmedAt = now();
        this._save();
        this.engine.markOutboundSent(rec.orderId, rec.txid, 'CONFIRMED');
        this._emit('settlement.updated', this._outboundView(rec));
      } else if (tx && tx.invalid) {
        rec.status = 'FAILED';
        rec.lastError = 'minepoa marked the payout tx invalid; operator must review';
        this._save();
        this._failEngine(rec);
      }
    }
    // 2. head of line: an un-acknowledged signed tx blocks new signing (nonce order)
    const pendingSigned = recs.find((r) => r.status === 'SIGNED');
    if (pendingSigned) {
      if (now() < pendingSigned.nextAttemptAt) return;
      try {
        await this.flush(); // its signed body must be durable before it can leave the box
      } catch (err) {
        this._tickErrors.push(`store: ${err.message}`);
        return;
      }
      const ok = await this._broadcastSigned(pendingSigned);
      if (!ok) return;
    }
    // 3. sign + broadcast queued orders, one at a time, only from confirmed on-chain funds
    const balanceMicros = bankRow && typeof bankRow.effectiveMicros === 'bigint' ? bankRow.effectiveMicros : null;
    const listed = bankRow?.listedIds || null;
    const tagged = new Map();
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) if (o.ord) tagged.set(o.ord, id);
    const claimed = new Set(Object.values(this.state.outbound).flatMap((o) => [o.txid, ...(o.superseded || []).map((x) => x.txid)]).filter(Boolean));
    for (const rec of recs) {
      if (rec.status !== 'QUEUED' && rec.status !== 'WAITING_FUNDS') continue;
      // Already paid on chain (e.g. state was lost and the inbound replayed): adopt, never pay twice.
      const paid = tagged.get(rec.orderId.slice(0, 12));
      if (paid && !claimed.has(paid)) {
        rec.txid = paid;
        rec.recoveredFromLedger = true;
        rec.nonce = null;
        rec.status = 'SENT';
        rec.sentAt = now();
        rec.lastError = null;
        claimed.add(paid);
        this._save();
        this.engine.markOutboundSent(rec.orderId, rec.txid, 'SENT');
        this._emit('settlement.updated', this._outboundView(rec));
        continue;
      }
      if (now() < rec.nextAttemptAt) continue;
      if (balanceMicros === null || !this.ledgerIndexComplete) return; // cannot prove solvency / non-payment this tick
      const amount = toMicros(rec.amountPoa);
      const spendable = balanceMicros - this._inFlightOutMicros(listed);
      if (spendable < amount) {
        if (rec.status !== 'WAITING_FUNDS') {
          rec.status = 'WAITING_FUNDS';
          rec.lastError = `Confirmed on-chain bank balance cannot cover ${rec.amountPoa} POA yet`;
          this._save();
          this._emit('settlement.updated', this._outboundView(rec));
        }
        continue;
      }
      let nonce;
      let parents;
      try {
        nonce = this.state.bankNonce ?? (await this.client.nextNonce(this.bankAddress));
        parents = await this._parents();
      } catch (err) {
        rec.lastError = err.message;
        this.ledgerProbe?.reportFailure('payout parents (/api/txs)', err);
        rec.nextAttemptAt = now() + this._backoff(++rec.attempts);
        this._save();
        return;
      }
      const signed = buildSignedTransfer({ wallet: this.bankWallet, to: rec.to, amount: rec.amountPoa, memo: rec.memo, nonce, parents, cid: this.client.chainId });
      let tx = signed;
      try {
        // One signed body per order (and re-sign generation) across all instances.
        const res = await this._persist.claim(`payout:${rec.orderId}:${rec.resigns || 0}`, { txid: signed.id, body: signed.body, nonce });
        if (!res.claimed) {
          const v = res.value || {};
          if (!v.body || txidOf(v.body) !== v.txid || v.body.to !== rec.to || toMicros(v.body.amount) !== toMicros(rec.amountPoa) || !verifyBody(v.body, this.bankAddress)) {
            throw new Error(`stored payout claim for ${rec.orderId} does not match the order`);
          }
          tx = { id: v.txid, body: v.body };
          nonce = Number(v.nonce ?? v.body.nonce);
          if (this.logger) this.logger(`payout ${rec.orderId} already signed by another instance; adopting ${v.txid.slice(0, 16)}`);
        }
      } catch (err) {
        rec.lastError = `store claim (payout): ${err.message}`;
        this._tickErrors.push(rec.lastError);
        rec.nextAttemptAt = now() + this._backoff(++rec.attempts);
        this._save();
        return;
      }
      rec.txid = tx.id;
      rec.body = tx.body;
      rec.nonce = nonce;
      rec.status = 'SIGNED';
      rec.signedAt = now();
      this.state.bankNonce = nonce; // reserved; advanced once the node accepts it
      this._save(); // write-ahead: the txid is durable before anything leaves the box
      try {
        await this.flush();
      } catch (err) {
        this._tickErrors.push(`store: ${err.message}`);
        return; // stays SIGNED; rebroadcast (same txid) once the store is writable
      }
      const ok = await this._broadcastSigned(rec);
      if (!ok) return;
    }
  }

  _outboundView(rec) {
    return {
      direction: 'outbound',
      orderId: rec.orderId,
      kind: rec.kind,
      sourceTxid: rec.sourceTxid,
      to: rec.to,
      amountPoa: rec.amountPoa,
      status: rec.status === 'QUEUED' || rec.status === 'WAITING_FUNDS' || rec.status === 'SIGNED' ? 'PENDING' : rec.status,
      rawStatus: rec.status,
      txid: rec.txid,
      explorer: rec.txid ? this.client.explorerTxUrl(rec.txid) : null,
      attempts: rec.attempts,
      lastError: rec.lastError,
      superseded: rec.superseded
    };
  }

  // ─── Loop ─────────────────────────────────────────────────────────────────

  tick() {
    if (this._tickPromise) return this._tickPromise;
    this._tickPromise = (async () => {
      this._tickErrors = [];
      try {
        await this.ready();
        if (this.ledgerProbe) await this.ledgerProbe.maybeProbe().catch(() => {});
        await this._syncSeed();
        const row = await this._scanBank();
        await this._confirmInbound();
        await this._reconcile(row);
        this._adoptOutbound();
        await this._processOutbound(row);
        await this.flush();
        this.lastTick = now();
        if (this._tickErrors.length) {
          this.lastError = this._tickErrors.join('; ');
          this.lastErrorAt = now();
        } else {
          this.lastError = null; // only report errors that are still happening
        }
        this.lastGoodTick = this._tickErrors.length ? this.lastGoodTick : now();
      } catch (err) {
        this.lastError = String(err.message || err);
        this.lastErrorAt = now();
        if (this.logger) this.logger(`settlement tick error: ${this.lastError}`);
      } finally {
        this._tickPromise = null;
      }
    })();
    return this._tickPromise;
  }

  kick(delayMs = 50) {
    if (this._kickTimer) return;
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      this.tick();
    }, delayMs);
    if (this._kickTimer.unref) this._kickTimer.unref();
  }

  start(intervalMs = 5000) {
    this.stop();
    this._timer = setInterval(() => this.tick(), intervalMs);
    if (this._timer.unref) this._timer.unref();
    this.tick();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._kickTimer) clearTimeout(this._kickTimer);
    this._kickTimer = null;
  }

  async idle() {
    while (this._tickPromise) await this._tickPromise;
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  getTxStatus(id) {
    if (this.state.inbound[id]) return this._inboundView(this.state.inbound[id]);
    const out = Object.values(this.state.outbound).find((o) => o.txid === id || o.orderId === id || o.superseded.some((s) => s.txid === id));
    if (out) return this._outboundView(out);
    if (this.engine.processedTxids.has(id)) return { txid: id, status: 'CONFIRMED', rawStatus: 'BOOKED', result: this.engine.processedTxids.get(id) };
    return null;
  }

  // ─── Bank coverage of bets ────────────────────────────────────────────────

  /**
   * Free funds for NEW bets, from the bank's real money:
   *   base  = min(confirmed on-chain balance - sent-but-unlisted payouts - queued/pending payouts
   *               - dev reserve - incentive pool,  internal NAV)
   *   limit = base - LP withdrawal liabilities (queued withdrawals + withdraw triggers in flight)
   * Every unsettled bet's worst-case payout is reserved against `limit` in the shared store
   * (scope "bets"), so free = limit - reserved. Fails closed (unknown) when the balance is
   * unknown or stale, the outflow index is incomplete, or reconciliation / audit is not OK.
   */
  coverageLimit() {
    const hold = this.tradingHold();
    if (hold) return { known: false, code: hold.status, reason: hold.reason };
    const row = this._lastRow;
    if (!row || typeof row.effectiveMicros !== 'bigint') return { known: false, code: 'BANK_BALANCE_UNKNOWN', reason: 'The bank balance on minepoa is unknown right now; bets are paused until it can be read.' };
    if (now() - this._lastRowAt > this.balanceStaleMs) return { known: false, code: 'BANK_BALANCE_STALE', reason: `The bank balance was last read ${Math.round((now() - this._lastRowAt) / 1000)}s ago; bets are paused until it is refreshed.` };
    let pendingOut = 0n;
    for (const o of Object.values(this.state.outbound)) if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT') pendingOut += toMicros(o.amountPoa);
    for (const item of this.engine.outboundQueue) if (item.status === 'PENDING' && !this.state.outbound[item.orderId]) pendingOut += BigInt(item.amountMicros);
    const onChainFree = row.effectiveMicros - this._inFlightOutMicros(row.listedIds) - pendingOut - this.engine.devReserveMicros - this.engine.incentivePoolMicros;
    const nav = this.engine.bankNavMicros;
    const base = onChainFree < nav ? onChainFree : nav;
    let withdrawLiab = 0n;
    for (const w of this.engine.withdrawalQueue || []) {
      try {
        withdrawLiab += this.engine.microsForShares(BigInt(w.sharesToRedeem));
      } catch {
        // ignore malformed
      }
    }
    for (const r of Object.values(this.state.inbound)) {
      if (!OPEN_IN.has(r.status) || !['LP_WITHDRAW', 'WITHDRAW', 'CLAIM'].includes(r.action)) continue;
      const pos = this.engine.lpPositions.get(r.from);
      if (pos) withdrawLiab += this.engine.microsForShares(pos.shares);
    }
    const limit = base - withdrawLiab;
    return { known: true, limitMicros: limit > 0n ? limit : 0n, baseMicros: base, onChainFreeMicros: onChainFree, navMicros: nav, withdrawalLiabilityMicros: withdrawLiab };
  }

  /** Refresh the bank balance (one tick) if it is missing or stale. */
  async ensureFreshBalance() {
    if (!this._lastRow || now() - this._lastRowAt > this.balanceStaleMs || !this.reconcile.at) await this.tick().catch(() => {});
  }

  /**
   * Can `worstMicros` more worst-case payout be covered? With opts.reserveKey it also reserves it
   * atomically (cross-instance). Returns { ok, unknown, code, reason, freeMicros, ... }.
   */
  async betCoverage(worstMicros, { reserveKey = null } = {}) {
    const lim = this.coverageLimit();
    if (!lim.known) return { ok: false, unknown: true, code: lim.code, reason: lim.reason };
    const w = BigInt(worstMicros);
    let used;
    if (reserveKey) {
      let r;
      try {
        r = await this._persist.reserveCapacity('bets', reserveKey, w.toString(), lim.limitMicros.toString(), this.inboundExpireMs + 5 * 60 * 1000);
      } catch (err) {
        return { ok: false, unknown: true, code: 'COVERAGE_STORE_ERROR', reason: `Could not reserve bank coverage (${err.message}); bets are paused.` };
      }
      used = BigInt(r.usedMicros);
      if (r.ok) return { ok: true, reserved: true, limitMicros: lim.limitMicros, usedMicros: used, freeMicros: lim.limitMicros - used, worstMicros: w };
    } else {
      try {
        used = BigInt(await this._persist.capacityUsed('bets'));
      } catch (err) {
        return { ok: false, unknown: true, code: 'COVERAGE_STORE_ERROR', reason: `Could not read bank coverage (${err.message}); bets are paused.` };
      }
      if (used + w <= lim.limitMicros) return { ok: true, limitMicros: lim.limitMicros, usedMicros: used, freeMicros: lim.limitMicros - used, worstMicros: w };
    }
    const free = lim.limitMicros > used ? lim.limitMicros - used : 0n;
    return {
      ok: false,
      code: 'BANK_INSUFFICIENT',
      reason: `The bank's free funds (${fromMicros(free)} POA after unsettled bets, pending payouts and withdrawals) cannot cover this worst-case payout of ${fromMicros(w)} POA.`,
      limitMicros: lim.limitMicros,
      usedMicros: used,
      freeMicros: free,
      worstMicros: w
    };
  }

  /** Reserve or throw (API / MCP / batch paths). */
  async reserveBetCoverage(key, worstMicros) {
    await this.ensureFreshBalance();
    const cov = await this.betCoverage(worstMicros, { reserveKey: key });
    if (!cov.ok) throw Object.assign(new Error(`${cov.reason} Not broadcast.`), { status: cov.unknown ? 503 : 409, code: cov.code, coverage: cov });
    return cov;
  }

  releaseBetCoverage(key, micros = null) {
    return this._persist.releaseCapacity('bets', key, micros === null ? null : String(micros)).catch((err) => this._tickErrors.push(`coverage release: ${err.message}`));
  }

  _releaseCoverage(rec) {
    if (!rec || !rec.coverage) return;
    const { key, micros } = rec.coverage;
    rec.coverage = null;
    // a batch shares one reservation key: release this roll's slice only
    this.releaseBetCoverage(key, key === rec.txid ? null : micros);
  }

  // ─── Reconciliation ───────────────────────────────────────────────────────

  /** Run one tick first if no reconcile pass has finished yet (cold start), then report the hold. */
  async ensureReconciled() {
    if (!this.reconcile.at) await this.tick().catch(() => {});
    if (this.ledgerProbe) await this.ledgerProbe.maybeProbe().catch(() => {});
    return this.tradingHold();
  }

  /**
   * null when trading is open; otherwise { status, reason } (bets / withdrawals refused).
   * RECONCILING / SOLVENCY_HOLD (books vs ledger) take precedence over LEDGER_UNAVAILABLE.
   */
  tradingHold() {
    if (this.reconcile && this.reconcile.status !== 'OK') {
      return { status: this.reconcile.status === 'SOLVENCY_HOLD' ? 'SOLVENCY_HOLD' : 'RECONCILING', reason: this.reconcile.reason };
    }
    return this.ledgerProbe ? this.ledgerProbe.hold() : null;
  }

  _knownOutTxids() {
    const known = new Set();
    for (const o of Object.values(this.state.outbound)) {
      if (o.txid) known.add(o.txid);
      for (const x of o.superseded || []) if (x.txid) known.add(x.txid);
    }
    for (const id of this.engine.recoveredOutflows.keys()) known.add(id);
    return known;
  }

  _knownOrderTags() {
    const tags = new Set();
    for (const o of Object.values(this.state.outbound)) tags.add(o.orderId.slice(0, 12));
    for (const item of this.engine.outboundQueue) tags.add(String(item.orderId).slice(0, 12));
    return tags;
  }

  /** Is this bank outflow final on the ledger? (index flag, else ask the node) */
  async _outFinal(txid) {
    const o = this.state.ledgerOut[txid];
    if (o && o.final) return true;
    const tx = await this.client.getTx(txid).catch(() => undefined);
    if (tx === undefined) throw new Error('minepoa unreachable');
    if (tx && this._confirmed(tx) && !tx.invalid) {
      if (o) o.final = true;
      return true;
    }
    return false;
  }

  /** 16-hex txid prefixes referenced by the memos of the bank's outgoing transfers (WIN/REFUND/PAYOUT/...). */
  _outflowRefs() {
    const refs = new Set();
    for (const o of Object.values(this.state.ledgerOut || {})) {
      for (const part of String(o.memo || '').split(':')) if (/^[0-9a-f]{16}$/.test(part)) refs.add(part);
    }
    return refs;
  }

  /** Claim a reconciliation decision so every instance books the same one. */
  async _claimDecision(txid, decision) {
    const res = await this._persist.claim(`reconcile:${txid}`, decision);
    return res.value;
  }

  _applyDecision(d) {
    if (d.kind === 'BET_WIN') {
      return this.engine.applyRecoveredBetWin({
        betTxid: d.betTxid,
        address: d.to,
        wagerMicros: BigInt(d.wagerMicros),
        payoutMicros: BigInt(d.amountMicros),
        payoutTxid: d.txid,
        targetBps: d.targetBps ?? null,
        direction: d.direction ?? null,
        memoRollDisplay: d.memoRoll ?? null,
        ts: d.ts
      });
    }
    if (d.kind === 'BET_REFUND') {
      return this.engine.applyRecoveredBetRefund({ betTxid: d.betTxid, address: d.to, refundMicros: BigInt(d.amountMicros), refundTxid: d.txid, ts: d.ts });
    }
    return this.engine.applyRecoveredOutflow({ txid: d.txid, to: d.to, amountMicros: BigInt(d.amountMicros), memo: d.memo, ts: d.ts });
  }

  /**
   * Ledger-first reconciliation (runs every tick, before outbound processing and before quotes are
   * re-opened). Never signs or pays anything: it only books what is already final on chain.
   */
  async _reconcile(row) {
    const prevStatus = this.reconcile.status;
    const set = (status, reason, extra = {}) => {
      this.reconcile = { ...this.reconcile, status, reason, at: now(), ...extra };
      if (prevStatus !== status) this._emit('settlement.reconcile', { status, reason });
    };
    if (!row || row.effectiveMicros === null || row.effectiveMicros === undefined) return set('PENDING', 'Waiting for a trustworthy bank balance from minepoa before reopening bets and withdrawals.');
    if (!this.ledgerIndexComplete) return set('PENDING', 'Still indexing the bank\'s outgoing transfers on minepoa (memos); bets and withdrawals reopen once every outflow is accounted for.');
    try {
      const known = this._knownOutTxids();
      const outs = Object.entries(this.state.ledgerOut || {});
      // 1. bets in review: match their on-chain payout / refund
      const review = Object.values(this.state.inbound).filter((r) => r.status === 'NEEDS_REVIEW' && r.action === 'BET');
      for (const rec of review) {
        if (this.engine.processedTxids.has(rec.txid)) {
          rec.status = 'BOOKED';
          rec.result = { ...(this.engine.processedTxids.get(rec.txid) || {}), provablyFair: undefined };
          rec.error = null;
          this._save();
          continue;
        }
        const tag = rec.txid.slice(0, 16);
        let match = null;
        for (const [id, o] of outs) {
          if (known.has(id) || o.to !== rec.from) continue;
          const memo = String(o.memo || '');
          if (memo.startsWith(`DICE1:WIN:${tag}:`) || memo.startsWith(`DICE1:REFUND:${tag}:`)) {
            match = { id, o, kind: memo.startsWith('DICE1:WIN:') ? 'BET_WIN' : 'BET_REFUND' };
            break;
          }
        }
        if (!match) {
          rec.error = 'Bet predates this vault state (state was lost) and no payout or refund for it is on the ledger: treated as unresolved (a loss leaves no payout). Not re-rolled; operator review.';
          continue;
        }
        if (!(await this._outFinal(match.id))) continue; // wait until the payout is final
        const parsed = parseDiceMemo(rec.memo || '');
        const roll = /:roll=(\d{1,2}\.\d{2})(?::|$)/.exec(match.o.memo || '');
        const decision = await this._claimDecision(match.id, {
          v: 1,
          kind: match.kind,
          txid: match.id,
          betTxid: rec.txid,
          to: rec.from,
          amountMicros: toMicros(match.o.amountPoa).toString(),
          wagerMicros: toMicros(rec.amountPoa).toString(),
          targetBps: parsed.valid ? parsed.targetBps : null,
          direction: parsed.valid ? parsed.direction : null,
          memoRoll: roll ? roll[1] : null,
          memo: String(match.o.memo || '').slice(0, 200),
          ts: Math.floor(now() / 1000)
        });
        const result = this._applyDecision(decision);
        known.add(match.id);
        rec.status = 'BOOKED';
        rec.bookedAt = now();
        rec.error = null;
        rec.recovered = true;
        rec.result = result
          ? { action: result.action, won: result.won, rollDisplay: result.rollDisplay, rollVerified: false, wagerPoa: result.wagerPoa, payoutPoa: result.payoutPoa || result.refundedPoa, payoutTxid: match.id }
          : null;
        this._save();
        this._emit('settlement.updated', this._inboundView(rec));
      }
      // 2. any other final bank outflow that nothing explains (only once every replay is booked)
      const refs = this._outflowRefs();
      const replaying = Object.values(this.state.inbound).some((r) => OPEN_IN.has(r.status) && r.discoveredBy === 'ledger-scan' && ((this.state.createdAt && Number(r.ledgerTs || 0) < this.state.createdAt) || refs.has(r.txid.slice(0, 16))));
      if (replaying) return set('PENDING', 'Replaying ledger deposits / withdrawals into the rebuilt vault; bets and withdrawals reopen when done.');
      const tags = this._knownOrderTags();
      const inboundTags = new Set(Object.keys(this.state.inbound).map((id) => id.slice(0, 16)));
      for (const id of this.engine.processedTxids.keys()) inboundTags.add(String(id).slice(0, 16));
      let recovered = 0;
      for (const [id, o] of outs) {
        if (known.has(id) || (o.ord && tags.has(o.ord))) continue;
        const memo = String(o.memo || '');
        const reviewTag = /^DICE1:(?:WIN|REFUND):([0-9a-f]{16}):/.exec(memo);
        if (reviewTag && review.some((r) => r.txid.startsWith(reviewTag[1]) && r.status === 'NEEDS_REVIEW')) continue; // handled above once final
        // An outflow that names an inbound tx we know (deposit / withdrawal / bet / chat) is that tx's payout:
        // it is adopted by its order tag when the tx is booked, or matched in review. Never book it as "unexplained".
        if (memo.split(':').some((part) => /^[0-9a-f]{16}$/.test(part) && inboundTags.has(part))) continue;
        if (!(await this._outFinal(id))) continue;
        const decision = await this._claimDecision(id, {
          v: 1,
          kind: 'UNMATCHED_OUTFLOW',
          txid: id,
          to: o.to,
          amountMicros: toMicros(o.amountPoa).toString(),
          memo: memo.slice(0, 200),
          ts: Math.floor(now() / 1000)
        });
        this._applyDecision(decision);
        known.add(id);
        recovered += 1;
        if (this.logger) this.logger(`reconcile: booked unmatched bank outflow ${id.slice(0, 16)} (${o.amountPoa} POA)`);
      }
      if (recovered) this._save();
      // 3. the books must be covered by the confirmed on-chain balance
      let pendingOut = 0n;
      for (const o of Object.values(this.state.outbound)) if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT') pendingOut += toMicros(o.amountPoa);
      for (const item of this.engine.outboundQueue) if (item.status === 'PENDING' && !this.state.outbound[item.orderId]) pendingOut += BigInt(item.amountMicros);
      const required = this.engine.bankNavMicros + this.engine.devReserveMicros + this.engine.incentivePoolMicros + pendingOut;
      const available = row.effectiveMicros - this._inFlightOutMicros(row.listedIds);
      const inReview = Object.values(this.state.inbound).filter((r) => r.status === 'NEEDS_REVIEW').map((r) => r.txid);
      const audit = { onChainPoa: fromMicros(available < 0n ? 0n : available), requiredPoa: fromMicros(required), ok: available >= required };
      if (!audit.ok) {
        return set('SOLVENCY_HOLD', `Books (${fromMicros(required)} POA) exceed the confirmed on-chain bank balance (${fromMicros(available < 0n ? 0n : available)} POA); bets and withdrawals are paused until reconciled.`, { inReview, audit, recovered: this.reconcile.recovered + recovered });
      }
      return set('OK', null, { inReview, audit, recovered: this.reconcile.recovered + recovered });
    } catch (err) {
      this._tickErrors.push(`reconcile: ${err.message}`);
      return set(prevStatus === 'OK' ? 'OK' : 'PENDING', prevStatus === 'OK' ? null : `Reconciliation could not finish (${err.message}); retrying.`);
    }
  }

  summary() {
    const count = (list, key) => list.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
    const outs = Object.values(this.state.outbound);
    const ins = Object.values(this.state.inbound);
    return {
      mode: 'chain',
      bankAddress: this.bankAddress,
      confirmPolicy: this.confirmPolicy,
      store: this.store.kind,
      storeDurable: this.store.durable !== false,
      lastTick: this.lastTick ? new Date(this.lastTick).toISOString() : null,
      lastGoodTick: this.lastGoodTick ? new Date(this.lastGoodTick).toISOString() : null,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      onChainBankBalancePoa: this.lastBankBalance?.balance ?? null,
      bankBalance: this.lastBankBalance,
      ledgerIndexComplete: this.ledgerIndexComplete,
      reconcile: { status: this.reconcile.status, reason: this.reconcile.reason, at: this.reconcile.at ? new Date(this.reconcile.at).toISOString() : null, inReview: this.reconcile.inReview, audit: this.reconcile.audit },
      trading: tradingLabel(this.tradingHold()),
      ledger: this.ledgerProbe ? this.ledgerProbe.view() : null,
      recoveredOutflows: [...this.engine.recoveredOutflows.entries()].slice(-20).map(([txid, r]) => ({ txid, ...r })),
      minepoa: this.client.stats || null,
      inbound: count(ins, 'status'),
      outbound: count(outs, 'status'),
      recentOutbound: outs
        .sort((a, b) => b.seq - a.seq)
        .slice(0, 20)
        .map((o) => this._outboundView(o)),
      openInbound: ins.filter((r) => OPEN_IN.has(r.status)).map((r) => this._inboundView(r))
    };
  }

  /** Internal books vs the real on-chain bank balance. */
  async auditAgainstChain() {
    const prevErrors = this._tickErrors;
    this._tickErrors = [];
    const row = await this._scanBankReadOnly();
    this._tickErrors = prevErrors;
    if (!row || row.effectiveMicros === null) throw new Error('Could not read a trustworthy bank balance from minepoa right now');
    const onChain = row.effectiveMicros;
    const unconfirmedIn = 0n; // the effective balance only counts FINAL inbound
    let pendingOut = 0n;
    for (const o of Object.values(this.state.outbound)) if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT') pendingOut += toMicros(o.amountPoa);
    for (const item of this.engine.outboundQueue) if (item.status === 'PENDING' && !this.state.outbound[item.orderId]) pendingOut += BigInt(item.amountMicros);
    const booked = this.engine.bankNavMicros + this.engine.devReserveMicros + this.engine.incentivePoolMicros;
    const required = booked + pendingOut;
    const confirmedOnChain = onChain - unconfirmedIn;
    const delta = confirmedOnChain - required;
    const sentUnconfirmed = this._inFlightOutMicros(row.listedIds);
    return {
      ok: delta >= 0n,
      bankAddress: this.bankAddress,
      onChainBalancePoa: fromMicros(onChain),
      unconfirmedInboundPoa: fromMicros(unconfirmedIn),
      confirmedOnChainPoa: fromMicros(confirmedOnChain < 0n ? 0n : confirmedOnChain),
      internal: {
        bankNavPoa: fromMicros(this.engine.bankNavMicros),
        devReserveUnpaidPoa: fromMicros(this.engine.devReserveMicros),
        incentivePoolPoa: fromMicros(this.engine.incentivePoolMicros),
        outboundNotYetSentPoa: fromMicros(pendingOut),
        outboundSentUnconfirmedPoa: fromMicros(sentUnconfirmed)
      },
      requiredOnChainPoa: fromMicros(required),
      deltaPoa: (delta < 0n ? '-' : '') + fromMicros(delta < 0n ? -delta : delta),
      note:
        delta >= 0n
          ? 'On-chain bank balance covers every booked liability (a surplus can be unbooked transfers or sent payouts the explorer has not reflected yet).'
          : 'SHORTFALL: the on-chain bank balance is below what the internal ledger owes. Payouts beyond the confirmed balance are held.',
      checkpoint: row.checkpoint ?? null,
      checkpointBalancePoa: row.balance,
      balanceSource: this.lastBankBalance?.source || null,
      unbookedDiceTransfers: Object.values(this.state.inbound).filter((r) => OPEN_IN.has(r.status)).map((r) => ({ txid: r.txid, from: r.from, amountPoa: r.amountPoa, status: r.status }))
    };
  }
}
