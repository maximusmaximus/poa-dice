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
import crypto from 'node:crypto';
import { BankWriter, BINDING_KEY } from './bank-writer.mjs';
import { buildSignedTransfer, fromMicros, isValidPoaAddress, parseDiceMemo, toMicros, txidOf, verifyBody } from './crypto-poa.mjs';
import { PersistQueue } from './settlement-store.mjs';
import { isLedgerBusy, isLedgerOutage, LEDGER_HOLD } from './ledger-probe.mjs';

const TERMINAL_OUT = new Set(['CONFIRMED', 'FAILED', 'REFUSED_DUPLICATE']);
const OPEN_IN = new Set(['SUBMITTING', 'BROADCAST', 'SEEN']);
const HOLD_ACTIONS = new Set(['BET', 'LP_WITHDRAW', 'WITHDRAW', 'CLAIM']);

/** Public trading state: OPEN, HOLD (reconciling / solvency) or PAUSED_LEDGER_UNAVAILABLE. */
/** Shared status row the bank writer publishes every tick (see _publishStatus). */
export const LEADER_STATUS_KEY = 'leader-status';
/** Trading hold when no bank writer has published a fresh status. */
export const NO_ACTIVE_LEADER = 'NO_ACTIVE_LEADER';
const STANDBY_STATUS_REFRESH_MS = 2000;
const REPLICA_RELOAD_MS = 30000;

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

function isRejectedReceipt(receipt) {
  return !!receipt && typeof receipt === 'object' && /^(rejected|invalid|failed)$/i.test(String(receipt.status || ''));
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
    rejectConfirmations = 3,
    rejectCheckIntervalMs = 15000,
    sentGraceMs = 20000,
    stuckAfterMs = 10 * 60 * 1000,
    nonceScanDepth = 12,
    writer = null,
    bindOnBoot = false,
    onLoadStateChange = null,
    loadRetryBaseMs = 2000,
    loadRetryMaxMs = 60000,
    leaderStatusMaxAgeMs = 90000,
    passMode = false,
    passEveryMs = 15000,
    rebroadcastAfterMs = 60000,
    payoutRetryMaxMs = 30000,
    trustedBalanceMaxAgeMs = 10 * 60 * 1000,
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
    // Rejected-payout reconciler (see _reconcilePayouts): a payout is re-signed only after minepoa has
    // definitively rejected it on `rejectConfirmations` separate checks, spaced `rejectCheckIntervalMs` apart.
    this.rejectConfirmations = Math.max(1, rejectConfirmations);
    this.rejectCheckIntervalMs = rejectCheckIntervalMs;
    this.sentGraceMs = sentGraceMs;
    this.stuckAfterMs = stuckAfterMs;
    this.nonceScanDepth = nonceScanDepth;
    this._txNonce = new Map(); // txid -> body.nonce of bank txs on the ledger (immutable)
    // Single writer (bank-writer.mjs): without a writer, this instance is read-only (fail-closed).
    this.writer = writer || new BankWriter({ store, bankAddress: bankWallet.address, enabled: false });
    this.bindOnBoot = Boolean(bindOnBoot);
    this._leaderToken = null; // fencing token the in-memory state was (re)loaded under
    this.foreign = []; // bank outflows this vault did not create (see _foreignOutflows)
    // Serverless: many instances share one Postgres vault. The bank writer (lease holder) publishes its
    // status every tick; every other instance reads it and refuses bets when it is older than this.
    this.leaderStatusMaxAgeMs = leaderStatusMaxAgeMs; // bets need a good settlement pass at most this old
    // Pass mode (serverless): no long-lived writer. Any instance runs a bounded pass under the lease
    // (taken at the start, released at the end), triggered by the cron tick and by requests.
    this.passMode = Boolean(passMode);
    this.passEveryMs = passEveryMs;
    this.rebroadcastAfterMs = rebroadcastAfterMs;
    this.payoutRetryMaxMs = payoutRetryMaxMs;
    // While the explorer is busy, the last complete bank read (plus our own in-flight txs) stands in for it.
    this.trustedBalanceMaxAgeMs = trustedBalanceMaxAgeMs;
    this._lastPass = null; // {holder, token, savedAt, at}: the last pass THIS instance completed as writer
    this._observePromise = null;
    this.passes = { started: 0, completed: 0, lastStartedAt: null, lastCompletedAt: null, lastMs: null };
    this.shared = null; // last leader status read from (or written to) the store
    this._sharedReadAt = 0;
    this._replicaSavedAt = null; // savedAt of the vault document this standby last loaded
    this._replicaAt = 0;
    this._standbyLocal = new Map(); // txid -> inbound rec this standby broadcast (kept across replica reloads)
    this._groupClaims = new Map(); // groupId -> pending group claim (standby batches)
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
    // Vault load: a store error (e.g. Postgres unreachable or a schema race) is retried on later ticks with
    // backoff. Until a load succeeds the instance is read-only: tick() does nothing else, the writer never
    // takes the lease, nothing is booked, rolled or signed. A bank mismatch in the stored document is fatal.
    this.onLoadStateChange = onLoadStateChange;
    this.loadRetryBaseMs = loadRetryBaseMs;
    this.loadRetryMaxMs = loadRetryMaxMs;
    this.vaultLoad = { status: 'LOADING', attempts: 0, failures: 0, lastError: null, lastErrorAt: null, nextRetryAt: null, loadedAt: null };
    let loaded;
    try {
      loaded = store.load();
    } catch (err) {
      loaded = Promise.reject(err);
    }
    if (loaded && typeof loaded.then === 'function') {
      this._loadPromise = this._trackLoad(loaded);
    } else {
      this.vaultLoad.attempts = 1;
      this._applyDoc(loaded);
      this._markLoaded();
      this._loadPromise = Promise.resolve();
    }
  }

  _markLoaded() {
    this._loaded = true;
    this.vaultLoad = { ...this.vaultLoad, status: 'LOADED', nextRetryAt: null, loadedAt: new Date(now()).toISOString() };
    if (this.onLoadStateChange) this.onLoadStateChange(this.vaultLoad);
  }

  /** One load attempt: applies the document on success; records the error and the next retry on failure. */
  _trackLoad(promise) {
    this.vaultLoad.attempts += 1;
    this.vaultLoad.status = 'LOADING';
    const p = Promise.resolve(promise).then(
      (doc) => {
        this._applyDoc(doc); // bank mismatch throws here and sets fatalError (never retried)
        this._markLoaded();
      },
      (err) => {
        const msg = `Could not load vault state from ${this.store.kind}: ${err && err.message ? err.message : err}`;
        this.vaultLoad.failures += 1;
        const delay = Math.min(this.loadRetryMaxMs, this.loadRetryBaseMs * 2 ** Math.min(10, this.vaultLoad.failures - 1));
        this.vaultLoad = { ...this.vaultLoad, status: 'FAILED', lastError: msg, lastErrorAt: new Date(now()).toISOString(), nextRetryAt: now() + delay };
        this.lastError = msg;
        this.lastErrorAt = now();
        if (this.onLoadStateChange) this.onLoadStateChange(this.vaultLoad);
        throw new Error(msg);
      }
    );
    p.catch(() => {});
    return p;
  }

  /** Retry a failed load (called from tick() once the backoff has passed). */
  _retryLoad() {
    let loaded;
    try {
      loaded = this.store.load();
    } catch (err) {
      loaded = Promise.reject(err);
    }
    this._loadPromise = this._trackLoad(loaded);
    return this._loadPromise;
  }

  /** Load status for health: {status LOADING|LOADED|FAILED, attempts, failures, lastError, nextRetryAt}. */
  loadView() {
    const v = this.vaultLoad;
    return { ...v, nextRetryAt: v.nextRetryAt ? new Date(v.nextRetryAt).toISOString() : null, retries: Math.max(0, v.attempts - 1) };
  }

  /** Resolves once state is loaded from the store (async for KV stores); rejects while the latest attempt failed. */
  ready() {
    const p = this._loadPromise;
    if (!this.bindOnBoot) return p;
    // POA_DICE_BIND_STORE: try the one-time binding as soon as the stored vault is loaded (also after a
    // delayed load; tick() retries the binding on later ticks as well).
    return p.then(() => {
      if (!this._bootBind) this._bootBind = this._tryBootBind().catch(() => {});
      return this._bootBind;
    });
  }

  async _tryBootBind() {
    if (!this.writer.enabled || !this.writer.supportsLease()) return;
    if (await this.writer.refresh()) return;
    if (this.writer.status !== 'UNBOUND') return;
    try {
      await this.bindStore({ via: 'env' });
      await this.writer.refresh();
    } catch (err) {
      this.lastError = `store binding: ${err.message}`;
      this.lastErrorAt = now();
    }
  }

  _applyDoc(doc) {
    this._docLoaded = Boolean(doc && doc.version === 1);
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
    // Rebuild the pending-bet reservations from the stored open bets (never added on top of what this
    // process already held: that double count drove the stored lock to -4.55 POA on 2026-10-26).
    this._rebuildReservations();
    if (this.engine.lockHeal && this.engine.lockHeal !== this._lastLockHeal) {
      this._lastLockHeal = this.engine.lockHeal;
      if (this.logger) this.logger(`vault load: locked collateral corrected (stored ${this.engine.lockHeal.storedMicros} micros, now ${this.engine.lockHeal.correctedMicros})`);
    }
    this._loaded = true;
    this.engine.onStateSaved = () => this._save();
    this._save();
  }

  /**
   * Exposure reservations held in this process = the open bets in the vault document that carry one,
   * plus reservations for submissions still in progress here (not in the document yet). Reservations
   * of bets that are settled, refunded or expired are dropped. Locked collateral is then re-derived.
   */
  _rebuildReservations() {
    const next = new Map();
    for (const rec of Object.values(this.state.inbound)) {
      if (OPEN_IN.has(rec.status) && rec.reserve) {
        try {
          next.set(rec.reserve.key, (next.get(rec.reserve.key) || 0n) + BigInt(rec.reserve.micros));
        } catch {
          // malformed reservation: ignore
        }
      }
    }
    for (const [key, micros] of this.engine.batchReservations) {
      if (next.has(key)) continue;
      const m = /^pending_([0-9a-f]{64})$/.exec(key);
      if (m) {
        const r = this.state.inbound[m[1]];
        if (this.engine.processedTxids.has(m[1]) || (r && !OPEN_IN.has(r.status))) continue; // settled, refunded or expired
      }
      next.set(key, micros); // a submission in progress here, or a local batch
    }
    this.engine.batchReservations = next;
    this.engine._syncLocked();
  }

  _save() {
    if (!this._loaded) return; // never overwrite stored state with a pre-load blank
    if (!this.writer.canWrite()) return; // read-only instances never write the shared vault document
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
    if (!this._loaded) await this.tick().catch(() => {});
    if (!this._loaded) {
      throw Object.assign(new Error(`${this.tradingHold().reason} Not broadcast; nothing was booked.`), { status: 503, code: 'SIGNER_READ_ONLY' });
    }
    await this.ready();
    const { body, txid, parsed } = this._validateInbound(txEnvelope);
    // The bank writer takes new txs itself. A standby (another instance holds the writer lease) validates
    // and broadcasts them and records them in the shared store for the writer; it never signs or settles.
    if (!this.writer.canWrite()) {
      const known = Boolean(this.state.inbound[txid]) || this.engine.processedTxids.has(txid);
      if (this.passMode && this.writer.status === 'STANDBY') await this._observe(STANDBY_STATUS_REFRESH_MS).catch(() => {});
      else if (!known || this.writer.status === 'STANDBY') await this.tick().catch(() => {});
      if (!this.writer.canWrite()) {
        if (this.writer.status === 'STANDBY') return this._submitAsStandby({ body, txid, parsed, reserve, groupId, coverage });
        if (!known) {
          const h = this.writer.hold();
          throw Object.assign(new Error(`${h.reason} Not broadcast; nothing was booked.`), { status: 503, code: 'SIGNER_READ_ONLY', txid });
        }
      }
    }
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
    // A bet is settled with the server seed committed when it was accepted, never a later/different one.
    if (parsed.action === 'BET' && !(await this._syncSeed())) throw Object.assign(new Error('Vault store unavailable (seed commitment); not broadcast'), { status: 503, txid });
    const rec = {
      txid,
      seq: ++this.state.seq,
      from: body.from,
      amountPoa: body.amount,
      memo: body.memo,
      action: parsed.action,
      seedCommit: parsed.action === 'BET' ? this._seedCommit() : null,
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
    if (!this.writer.canWrite() && this.writer.status === 'STANDBY') {
      // The writer creates the group from this claim when it books the first member.
      const p = Promise.resolve(this.store.claim(`group:${groupId}`, { count, address, createdAt: now() }));
      p.catch(() => {});
      this._groupClaims.set(groupId, p);
      return;
    }
    this._save();
  }

  /**
   * Standby path of submitInbound: the bank writer is another instance. Requires a fresh writer status
   * (else NO_ACTIVE_LEADER), applies the writer's trading hold, reserves bet coverage in the shared store,
   * records the tx as accepted (claim `accepted:<txid>`, with the writer's seed commitment) and only then
   * broadcasts it. The writer books it from the ledger. Nothing here signs, settles, pays or refunds.
   */
  async _submitAsStandby({ body, txid, parsed, reserve, groupId, coverage }) {
    const refuse = (msg, status, code) => Object.assign(new Error(msg), { status, code, txid });
    const existing = this.state.inbound[txid];
    if (existing && existing.status !== 'FAILED' && existing.status !== 'EXPIRED') return this._inboundView(existing, { duplicate: true });
    if (this.engine.processedTxids.has(txid)) return { txid, status: 'BOOKED', duplicate: true, result: this.engine.processedTxids.get(txid) };
    if (now() - this._sharedReadAt > STANDBY_STATUS_REFRESH_MS) await this._readShared();
    if (!this._sharedFresh()) {
      const h = this._standbyHold();
      throw refuse(`${h.reason} Not broadcast; nothing was booked.`, 503, NO_ACTIVE_LEADER);
    }
    if (this.ledgerProbe) {
      await this.ledgerProbe.maybeProbe().catch(() => {});
      const lh = this.ledgerProbe.hold();
      if (lh) throw refuse(`${lh.reason} Not broadcast; nothing was booked.`, 503, LEDGER_HOLD);
    }
    if (HOLD_ACTIONS.has(parsed.action)) {
      const hold = this.tradingHold();
      if (hold) throw refuse(`${hold.reason} Not broadcast; try again shortly.`, 503, hold.status);
    }
    let prior;
    try {
      prior = await this.store.peek(`accepted:${txid}`);
    } catch (err) {
      throw refuse(`Vault store unavailable; not broadcast: ${err.message}`, 503, 'SETTLEMENT_STORE_ERROR');
    }
    if (prior) {
      const seen = await this.client.getTx(txid).catch(() => null);
      if (seen) return { direction: 'inbound', txid, status: 'PENDING_CONFIRMATION', rawStatus: 'BROADCAST', action: parsed.action, from: body.from, amountPoa: body.amount, explorer: this.client.explorerTxUrl(txid), duplicate: true };
      throw refuse('This signed transaction was already submitted once and is not on the ledger; it is not broadcast again. Sign a new one.', 409, 'ALREADY_SUBMITTED');
    }
    const seed = this.shared.seed;
    if (parsed.action === 'BET' && (!seed || !seed.hash)) throw refuse('The bank writer has not published its seed commitment yet; not broadcast.', 503, NO_ACTIVE_LEADER);
    let cov = coverage;
    if (parsed.action === 'BET' && !cov) {
      const q = this.engine.quoteBet({ address: body.from, amountPoa: body.amount, targetBps: parsed.targetBps, direction: parsed.direction });
      if (!q.payoutOnWinMicros) throw Object.assign(new Error(q.error || 'Bet outside allowed limits'), { status: 400, code: 'BET_LIMITS', quote: q });
      await this.reserveBetCoverage(txid, BigInt(q.payoutOnWinMicros));
      cov = { key: txid, micros: String(q.payoutOnWinMicros) };
    }
    const rec = {
      txid,
      seq: 0,
      from: body.from,
      amountPoa: body.amount,
      memo: body.memo,
      action: parsed.action,
      seedCommit: parsed.action === 'BET' ? { epoch: seed.epoch, hash: seed.hash, at: now() } : null,
      status: 'SUBMITTING',
      submittedAt: now(),
      reserve,
      coverage: cov ? { key: cov.key, micros: String(cov.micros) } : null,
      groupId,
      attempts: 0,
      error: null,
      result: null,
      ledger: null,
      acceptedBy: 'standby'
    };
    try {
      if (groupId && this._groupClaims.has(groupId)) await this._groupClaims.get(groupId);
      const res = await this.store.claim(`accepted:${txid}`, {
        v: 1,
        txid,
        from: rec.from,
        amountPoa: rec.amountPoa,
        memo: rec.memo,
        action: rec.action,
        seedCommit: rec.seedCommit,
        coverage: rec.coverage,
        groupId,
        submittedAt: rec.submittedAt,
        via: 'standby',
        instance: this.writer.holderId,
        writerToken: this.shared.token ?? null
      });
      if (!res.claimed) throw new Error('accepted concurrently by another request');
    } catch (err) {
      if (cov && cov.key === txid && !String(err.message).includes('concurrently')) this._releaseCoverage(rec);
      throw refuse(`Vault store unavailable; not broadcast: ${err.message}`, 503, 'SETTLEMENT_STORE_ERROR');
    }
    this.state.inbound[txid] = rec;
    this._standbyLocal.set(txid, rec);
    try {
      rec.attempts += 1;
      const resp = await this.client.submitTx(body);
      if (resp && Number.isInteger(Number(resp.next_nonce))) this._nonceCache.set(body.from, { next: Number(resp.next_nonce), at: now() });
      rec.status = 'BROADCAST';
    } catch (err) {
      this.ledgerProbe?.reportFailure('player broadcast', err);
      const seen = await this.client.getTx(txid).catch(() => null);
      if (seen) {
        rec.status = 'BROADCAST';
      } else {
        rec.status = 'FAILED';
        rec.error = String(err.message || err);
        this._nonceCache.delete(body.from);
        this._releaseCoverage(rec);
        this._emit('settlement.updated', this._inboundView(rec));
        throw refuse(`Broadcast to minepoa failed; nothing was booked: ${rec.error}`, 502, 'BROADCAST_FAILED');
      }
    }
    this._emit('settlement.updated', this._inboundView(rec));
    if (this.passMode) await this.maybePass({ force: true, budgetMs: 8000 }).catch(() => {});
    return this._inboundView(this.state.inbound[txid] || rec, { acceptedBy: 'standby' });
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
    // A bet this store never accepted (found only on the ledger) and older than the store's binding:
    // never rolled, never paid. Another copy of the server (or a lost state) may have handled it.
    if (rec.action === 'BET' && rec.discoveredBy === 'ledger-scan' && !this.engine.processedTxids.has(rec.txid)) {
      if (this._preBinding(rec.txid, b.ts)) {
        rec.status = 'NEEDS_REVIEW';
        rec.ledger = { atts: tx.atts, final: tx.final };
        rec.reviewReason = 'LEDGER_ONLY_BET';
        rec.error = 'Bet found only on the ledger and older than this vault store\'s binding: not rolled and not paid. Listed in the audit for operator review.';
        this._save();
        this._emit('settlement.updated', this._inboundView(rec));
        return;
      }
    }
    // Seed commitment: roll only with the seed committed when the bet was accepted.
    if (rec.action === 'BET' && rec.seedCommit && !this.engine.processedTxids.has(rec.txid) && rec.seedCommit.hash !== this.engine.seedManager.currentSeedHash) {
      rec.status = 'NEEDS_REVIEW';
      rec.ledger = { atts: tx.atts, final: tx.final };
      rec.reviewReason = 'SEED_COMMITMENT_CHANGED';
      rec.error = 'The server seed changed since this bet was accepted; it is not re-rolled with a different seed. Operator review.';
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
      if (ticket && rec.seedCommit && ticket.serverSeedHash && ticket.serverSeedHash !== rec.seedCommit.hash && !this.engine.processedTxids.has(rec.txid)) {
        rec.status = 'NEEDS_REVIEW';
        rec.reviewReason = 'SEED_COMMITMENT_CHANGED';
        rec.error = 'The stored settlement ticket uses a different server seed than the one committed for this bet; not rolled. Operator review.';
        this._save();
        return;
      }
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
      const trusted = isLedgerBusy(err) ? this._trustedRow() : null;
      if (trusted) {
        // Explorer busy / slow: the last complete read stands in (bounded age); our own payouts since then
        // are subtracted as in flight (_inFlightOutMicros), deposits since then are simply not counted yet.
        this._lastRow = trusted;
        this._lastRowAt = now();
        this.ledgerIndexComplete = true; // the trusted read was complete when it was taken
        return trusted;
      }
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
        let accepted = null;
        try {
          accepted = await this._acceptedClaim(t, memo);
        } catch (err) {
          this._tickErrors.push(`acceptance ${t.id.slice(0, 12)}: ${err.message}`);
          continue; // retried next tick: never book a standby-accepted bet without its seed commitment
        }
        this.state.inbound[t.id] = {
          txid: t.id,
          seq: ++this.state.seq,
          from: t.from,
          amountPoa: t.amount,
          memo,
          action: parseDiceMemo(memo).action || null,
          seedCommit: parseDiceMemo(memo).action === 'BET' ? this._seedCommit() : null,
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
        if (accepted) Object.assign(this.state.inbound[t.id], accepted);
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
    if (outIndexComplete) this._noteTrustedRow(row, txs);
    return row;
  }

  /** The document is the one the last writer published (same savedAt) and that status is recent. */
  async _handoverFromFreshStatus(doc) {
    if (!doc) return false;
    const st = await this._readShared();
    if (!st || st.docSavedAt === undefined || st.docSavedAt === null) return false;
    return st.docSavedAt === this._loadedSavedAt && now() - Number(st.at || 0) <= this.trustedBalanceMaxAgeMs;
  }

  /** Remember the last complete bank read (in the vault document, so every instance has it). */
  _noteTrustedRow(row, txs) {
    const outIds = txs.filter((t) => t.from === this.bankAddress && t.to !== this.bankAddress).map((t) => t.id);
    const prev = this.state.trustedBank;
    const eff = String(row.effectiveMicros);
    const changed = !prev || prev.effectiveMicros !== eff || (prev.listedOutIds || []).length !== outIds.length;
    if (!changed && now() - Number(prev.at || 0) < 60000) return;
    this.state.trustedBank = { effectiveMicros: eff, listedOutIds: outIds, checkpointBalance: row.balance ?? null, checkpoint: row.checkpoint ?? null, at: now() };
    this._save();
  }

  /** The last complete bank read as a row, if it is recent enough to stand in for a busy explorer. */
  _trustedRow() {
    const tb = this.state.trustedBank;
    if (!tb || !tb.effectiveMicros) return null;
    const age = now() - Number(tb.at || 0);
    if (!(age >= 0 && age <= this.trustedBalanceMaxAgeMs)) return null;
    let eff;
    try {
      eff = BigInt(tb.effectiveMicros);
    } catch {
      return null;
    }
    const row = { address: this.bankAddress, balance: tb.checkpointBalance, checkpoint: tb.checkpoint, txs: [], effectiveMicros: eff, listedIds: new Set(tb.listedOutIds || []), fromTrusted: true, trustedAt: Number(tb.at) };
    this.lastBankBalance = {
      ...(this.lastBankBalance || {}),
      balance: fromMicros(eff < 0n ? 0n : eff),
      source: 'last-trusted-read',
      trustedAt: new Date(Number(tb.at)).toISOString(),
      trustedAgeMs: age,
      at: now()
    };
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

  _payoutRetryAt(attempts, err = null) {
    const wait = err?.busy && err.retryAfterMs ? err.retryAfterMs : this._backoff(attempts);
    return now() + Math.min(wait, this.payoutRetryMaxMs);
  }

  async _broadcastSigned(rec) {
    // Never pay twice: if this exact txid is already known to the node, it is sent.
    let readErr = null;
    const known = await this.client.getTx(rec.txid).catch((err) => {
      readErr = err;
      return undefined;
    });
    // The read node being busy says nothing about the tx. The SAME signed body (same txid, same nonce)
    // is still sent: it can land at most once, so this never pays twice.
    const readBusy = known === undefined && Boolean(readErr?.busy);
    if (known === undefined && !readBusy) {
      rec.nextAttemptAt = this._payoutRetryAt(++rec.attempts);
      rec.lastError = 'minepoa unreachable';
      return false;
    }
    if (known) return this._markSent(rec, {});
    // Never resend a body minepoa already rejected for good (e.g. bad nonce): the reconciler decides what
    // happens to the order. A NONCE_GAP body is the exception: it is resent unchanged once the gap is filled.
    if (!rec.forceRebroadcast && !readBusy) {
      const receipt = await this._receipt(rec.txid);
      if (isRejectedReceipt(receipt)) {
        this._markRejected(rec, String(receipt.error || 'rejected'), 'receipt');
        return false;
      }
    }
    rec.forceRebroadcast = false;
    try {
      rec.attempts += 1;
      const resp = await this.client.submitTx(rec.body);
      return this._markSent(rec, resp || {});
    } catch (err) {
      rec.lastError = String(err.message || err);
      // Outages (401/403/5xx/timeouts) pause trading; a definitive rejection (4xx about the tx) does not.
      this.ledgerProbe?.reportFailure('payout broadcast', err);
      if (err.definitive) {
        const again = await this.client.getTx(rec.txid).catch(() => undefined);
        if (again) return this._markSent(rec, {});
        // Not re-signed here: the reconciler re-checks it before anything new is signed for this order.
        this._markRejected(rec, String(err.body?.error || err.message || 'rejected'), 'submit');
        return false;
      }
      // Stays signed and retries with backoff (same signed body, same txid: never paid twice).
      // Busy: wait for minepoa's retry_after; this is ledger-degraded, not a trading hold.
      rec.nextAttemptAt = this._payoutRetryAt(rec.attempts, err);
      this._save();
      this._emit('settlement.updated', this._outboundView(rec));
      return false;
    }
  }

  /** minepoa refused this exact body. Stop sending it; _reconcilePayouts decides (re-sign / wait / resend). */
  _markRejected(rec, error, source) {
    const expected = parseExpectedNonce(error);
    if (!rec.rejection || rec.rejection.txid !== rec.txid) {
      rec.rejection = { txid: rec.txid, nonce: rec.nonce, error, source, expected, kind: null, firstAt: now(), lastCheckAt: 0, checks: 0, consumedBy: null, lastTransient: null };
    } else {
      rec.rejection.error = error;
      if (expected !== null) rec.rejection.expected = expected;
    }
    rec.status = 'REJECTED';
    rec.forceRebroadcast = false;
    rec.lastError = `minepoa rejected ${String(rec.txid).slice(0, 16)}: ${error}`;
    this._save();
    this._emit('settlement.updated', this._outboundView(rec));
  }

  _markSent(rec, resp) {
    rec.status = 'SENT';
    rec.sentAt = now();
    rec.lastError = null;
    rec.rejection = null;
    const next = Number(resp.next_nonce);
    // Informational only: the next bank nonce is always re-derived from minepoa when signing.
    if (Number.isInteger(rec.nonce)) this.state.bankNonce = Number.isInteger(next) && next > rec.nonce ? next : rec.nonce + 1;
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
        rec.confirmedVia = 'explorer';
        this._save();
        this.engine.markOutboundSent(rec.orderId, rec.txid, 'CONFIRMED');
        this._emit('settlement.updated', this._outboundView(rec));
      } else if (!(tx && tx.invalid)) {
        // Explorer busy, behind, or not final yet: minepoa's receipt for this exact signed tx is enough.
        const receipt = await this._receiptConfirms(rec);
        if (receipt) {
          rec.status = 'CONFIRMED';
          rec.confirmedAt = now();
          rec.confirmedVia = 'receipt';
          rec.receipt = { status: receipt.status, height: receipt.height ?? null, ts: receipt.ts ?? null };
          this._save();
          this.engine.markOutboundSent(rec.orderId, rec.txid, 'CONFIRMED');
          this._emit('settlement.updated', this._outboundView(rec));
          if (this.logger) this.logger(`payout ${rec.orderId} confirmed from its receipt (${receipt.status}, height ${receipt.height ?? '?'})`);
        }
      } else if (tx && tx.invalid) {
        rec.status = 'FAILED';
        rec.lastError = 'minepoa marked the payout tx invalid; operator must review';
        this._save();
        this._failEngine(rec);
      }
    }
    // 1b. payouts minepoa refused (or never took): detect, confirm repeatedly, then re-sign safely
    await this._reconcilePayouts(recs);
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
      // A re-signed order: if any earlier body of it reached the ledger after all, adopt it (never pay twice).
      if ((rec.superseded || []).length) {
        const landed = await this._landedSuperseded(rec);
        if (landed === undefined) {
          rec.lastError = 'minepoa unreachable (checking earlier payout bodies)';
          rec.nextAttemptAt = now() + this._backoff(++rec.attempts);
          this._save();
          return;
        }
        if (landed) {
          this._adoptLanded(rec, landed);
          continue;
        }
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
      // Never sign twice for one bet: the ledger is checked for any bank payout that references it.
      const dup = this._ledgerPaidFor(rec);
      if (dup) {
        if (dup.adopt) {
          this._adoptLanded(rec, dup.txid);
          rec.recoveredFromLedger = true;
          continue;
        }
        rec.status = 'REFUSED_DUPLICATE';
        rec.lastError = `refused: the ledger already has bank payout ${dup.txid.slice(0, 16)} for this bet (${dup.why}); never paid twice. Operator review.`;
        rec.duplicateOf = dup.txid;
        this._failEngine(rec);
        this._save();
        this._emit('settlement.updated', this._outboundView(rec));
        continue;
      }
      let fence;
      try {
        fence = await this.writer.assertLeader();
      } catch (err) {
        this._tickErrors.push(`signing stopped: ${err.message}`);
        return;
      }
      let nonce;
      let parents;
      try {
        nonce = await this._chooseBankNonce(rec);
      } catch (err) {
        rec.lastError = `bank nonce: ${err.message}`;
        this._tickErrors.push(rec.lastError);
        rec.nextAttemptAt = now() + this._backoff(++rec.attempts);
        this._save();
        return;
      }
      try {
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
        const res = await this._persist.claim(`payout:${rec.orderId}:${rec.resigns || 0}`, { txid: signed.id, body: signed.body, nonce, fence });
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
      rec.nonceRule = null;
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

  // ─── Single writer, store binding, foreign outflows ───────────────────────

  _seedCommit() {
    return { epoch: this.engine.seedManager.epochId, hash: this.engine.seedManager.currentSeedHash, at: now() };
  }

  /**
   * Writer side of a standby acceptance: the claim a standby wrote before broadcasting this ledger tx
   * (seed commitment, coverage reservation, batch group). Only a claim that matches the tx is used.
   * Returns rec fields to merge, or null.
   */
  async _acceptedClaim(t, memo) {
    if (typeof this.store.peek !== 'function') return null;
    const a = await this.store.peek(`accepted:${t.id}`);
    if (!a || a.txid !== t.id || a.from !== t.from || String(a.memo) !== String(memo) || toMicros(a.amountPoa) !== toMicros(t.amount)) return null;
    const fields = { acceptedBy: 'standby', submittedAt: Number(a.submittedAt) || now() };
    if (a.action === 'BET' && a.seedCommit && a.seedCommit.hash) fields.seedCommit = { epoch: a.seedCommit.epoch, hash: a.seedCommit.hash, at: a.seedCommit.at };
    if (a.coverage && a.coverage.key && a.coverage.micros) fields.coverage = { key: String(a.coverage.key), micros: String(a.coverage.micros) };
    if (a.groupId) {
      if (!this.state.groups[a.groupId]) {
        const g = await this.store.peek(`group:${a.groupId}`);
        if (g) this.state.groups[a.groupId] = { count: g.count, address: g.address, resolved: 0, done: 0, wins: 0, losses: 0, netMicros: '0', completed: false, createdAt: g.createdAt || now() };
      }
      if (this.state.groups[a.groupId]) fields.groupId = a.groupId;
    }
    return fields;
  }

  // ─── Shared writer status (serverless: many instances, one bank writer) ──

  /**
   * Is there a recent GOOD settlement pass? Measured from the last pass that finished without errors
   * (status.goodAt), not from the lease: between passes nobody holds the lease, and that is normal.
   */
  _sharedFresh(s = this.shared) {
    if (!s) return false;
    const good = Number(s.goodAt ?? s.lastGoodTick ?? 0);
    if (!Number.isFinite(good) || good <= 0) return false;
    return now() - good <= this.leaderStatusMaxAgeMs;
  }

  /** Is a settlement pass due (no pass has completed anywhere for passEveryMs)? */
  async passDue() {
    if (now() - this._sharedReadAt > STANDBY_STATUS_REFRESH_MS) await this._readShared();
    const at = Number(this.shared?.at || 0);
    return !at || now() - at > this.passEveryMs;
  }

  /**
   * Run one settlement pass if one is due (or force), waiting at most budgetMs. The pass itself is
   * idempotent; if this instance is frozen mid-pass, its lease expires and the next pass (any
   * instance) carries on from the stored vault.
   */
  async maybePass({ force = false, budgetMs = 8000 } = {}) {
    if (!this._loaded && this.vaultLoad.status !== 'FAILED') return { ran: false };
    if (!force && !(await this.passDue())) return { ran: false };
    let timer;
    const finished = await Promise.race([
      this.tick().then(() => true),
      new Promise((r) => {
        timer = setTimeout(() => r(false), budgetMs);
        if (timer.unref) timer.unref();
      })
    ]).finally(() => clearTimeout(timer));
    return { ran: true, finished };
  }

  /** Standby: refresh the writer status / replica (never during this instance's own pass). */
  async _observe(maxAgeMs = 0) {
    if (this._tickPromise) return this._tickPromise;
    if (maxAgeMs && now() - this._sharedReadAt <= maxAgeMs) return;
    if (this.writer.status !== 'STANDBY' || this.writer.canWrite()) return this.tick();
    if (!this._observePromise) {
      this._observePromise = this._standbyTick().finally(() => {
        this._observePromise = null;
      });
    }
    return this._observePromise;
  }

  async _readShared() {
    if (typeof this.store.getStatus !== 'function') return null;
    try {
      this.shared = await this.store.getStatus(LEADER_STATUS_KEY);
      this._sharedReadAt = now();
      // A sustained ledger outage is measured from when ANY instance last saw minepoa healthy.
      if (this.ledgerProbe?.noteRemoteOk && this.shared?.ledger?.lastOkAt) this.ledgerProbe.noteRemoteOk(this.shared.ledger.lastOkAt);
    } catch (err) {
      this._tickErrors.push(`writer status: ${err.message}`);
    }
    return this.shared;
  }

  _statusDoc() {
    const hold = this._leaderHold();
    const lim = this.coverageLimit();
    const r = this.reconcile || {};
    return {
      v: 1,
      holder: this.writer.holderId,
      token: this.writer.lease?.token ?? null,
      leaseExpiresAt: Number(this.writer.lease?.expiresAt || 0),
      at: now(),
      trading: tradingLabel(hold),
      hold: hold ? { status: hold.status, reason: hold.reason } : null,
      reconcile: { status: r.status || null, reason: r.reason || null, at: r.at || null, inReview: r.inReview || [], audit: r.audit || null },
      foreignOutflows: this.foreign,
      onChainBankBalancePoa: this.lastBankBalance?.balance ?? null,
      coverage: lim.known ? { known: true, limitMicros: lim.limitMicros.toString() } : { known: false, code: lim.code, reason: lim.reason },
      seed: { epoch: this.engine.seedManager.epochId, hash: this.engine.seedManager.currentSeedHash },
      docSavedAt: this.state.savedAt ?? null,
      lastGoodTick: this.lastGoodTick || null,
      goodAt: this.lastGoodTick || null,
      passMs: this.passes.lastStartedAt ? now() - this.passes.lastStartedAt : null,
      passMode: this.passMode,
      ledger: this.ledgerProbe ? { status: this.ledgerProbe.status, lastError: this.ledgerProbe.lastError || null, lastOkAt: this.ledgerProbe.lastOkAt ?? null } : null,
      lastError: this.lastError || null
    };
  }

  /** Writer only: publish this tick's status for every other instance (fenced by the lease in Postgres). */
  async _publishStatus() {
    if (typeof this.store.putStatus !== 'function' || !this.writer.canWrite()) return;
    try {
      const doc = this._statusDoc();
      await this.store.putStatus(LEADER_STATUS_KEY, doc);
      this.shared = doc;
      this._sharedReadAt = now();
    } catch (err) {
      this._tickErrors.push(`writer status publish: ${err.message}`);
    }
  }

  /** Standby: follow the shared vault document (read-only) and the writer's status. Never writes. */
  async _standbyTick() {
    const s = await this._readShared();
    const due = !this._replicaAt || now() - this._replicaAt > REPLICA_RELOAD_MS;
    if (due || (s && s.docSavedAt !== this._replicaSavedAt)) {
      try {
        const doc = await this._reloadFromStore();
        this._replicaSavedAt = doc?.savedAt ?? null;
        this._replicaAt = now();
        for (const [id, rec] of this._standbyLocal) {
          if (this.state.inbound[id] || this.engine.processedTxids.has(id) || now() - rec.submittedAt > this.inboundExpireMs) this._standbyLocal.delete(id);
          else this.state.inbound[id] = rec;
        }
        this._rebuildReservations();
      } catch (err) {
        this._tickErrors.push(`standby reload: ${err.message}`);
      }
    }
    if (this._sharedFresh()) this.foreign = this.shared.foreignOutflows || [];
    this.lastTick = now();
    this.lastError = this._tickErrors.length ? this._tickErrors.join('; ') : null;
    if (this.lastError) this.lastErrorAt = now();
  }

  /** Writer status as this instance sees it (health / settlement). */
  leaderView() {
    const s = this.shared;
    const self = this.writer.canWrite();
    return {
      active: self || this._sharedFresh(),
      passMode: this.passMode,
      lastPassAt: s?.at ? new Date(Number(s.at)).toISOString() : null,
      lastGoodPassAt: s?.goodAt ? new Date(Number(s.goodAt)).toISOString() : null,
      goodPassAgeMs: s?.goodAt ? Math.max(0, now() - Number(s.goodAt)) : null,
      passRunningHere: Boolean(this._tickPromise),
      thisInstance: self ? 'WRITER' : this.writer.status,
      statusAt: s?.at ? new Date(Number(s.at)).toISOString() : null,
      statusAgeMs: s?.at ? Math.max(0, now() - Number(s.at)) : null,
      maxAgeMs: this.leaderStatusMaxAgeMs,
      token: s?.token ?? null,
      leaseExpiresAt: s?.leaseExpiresAt ? new Date(Number(s.leaseExpiresAt)).toISOString() : null,
      trading: s?.trading ?? null,
      hold: s?.hold ?? null,
      lastGoodTick: s?.lastGoodTick ? new Date(Number(s.lastGoodTick)).toISOString() : null
    };
  }

  /** Writer only: apply foreign-outflow acknowledgements recorded by any instance (claims `foreign-ack:<txid>`). */
  async _applyForeignAcks() {
    if (!this.writer.canWrite() || typeof this.store.peek !== 'function') return 0;
    this.state.foreignAck = this.state.foreignAck || {};
    let applied = 0;
    for (const f of this._foreignOutflows()) {
      if (f.acknowledged) continue;
      const a = await this.store.peek(`foreign-ack:${f.txid}`);
      if (!a || !['book_loss', 'reimbursed'].includes(a.mode)) continue;
      if (a.mode === 'book_loss') {
        const o = this.state.ledgerOut[f.txid];
        const d = await this._claimDecision(f.txid, { v: 1, kind: 'UNMATCHED_OUTFLOW', txid: f.txid, to: o.to, amountMicros: toMicros(o.amountPoa).toString(), memo: String(o.memo || '').slice(0, 200), ts: Math.floor(now() / 1000), foreign: true });
        this._applyDecision(d);
      }
      this.state.foreignAck[f.txid] = { mode: a.mode, at: a.at || new Date(now()).toISOString(), ...(a.note ? { note: a.note } : {}) };
      applied += 1;
    }
    if (applied) this._save();
    return applied;
  }

  async _reloadFromStore() {
    const doc = await this.store.load();
    this._loadedSavedAt = doc?.savedAt ?? null; // as stored (applying the document may re-save it)
    if (doc && doc.version === 1) {
      this.state = { version: 1, bankAddress: this.bankAddress, bankNonce: null, inbound: {}, outbound: {}, groups: {}, ledgerOut: {}, seq: 0, createdAt: Math.floor(now() / 1000) };
      this._applyDoc(doc);
    }
    this._seedSyncedEpoch = null;
    return doc && doc.version === 1 ? doc : null;
  }

  /** Bank txids a STORED vault document knows: {out, in} (never this instance's in-memory copy). */
  static docKnownIds(doc) {
    const out = new Set();
    const inb = new Set();
    if (!doc || doc.version !== 1) return { out, in: inb };
    const eng = doc.engine || {};
    for (const id of Object.keys(doc.ledgerOut || {})) out.add(id);
    for (const e of eng.recoveredOutflows || []) out.add(e[0]);
    for (const o of Object.values(doc.outbound || {})) {
      if (o.txid) out.add(o.txid);
      for (const x of o.superseded || []) if (x.txid) out.add(x.txid);
    }
    for (const id of Object.keys(doc.inbound || {})) inb.add(id);
    for (const e of eng.processedTxids || []) inb.add(e[0]);
    return { out, in: inb };
  }

  /**
   * Taking the writer lease: the stored document must account for every bank outflow on the ledger
   * (known to the document, on the ledger before the binding, or acknowledged by an operator).
   * Returns the unaccounted outflow ids, or undefined when minepoa cannot answer.
   */
  async _unaccountedOutflows(doc) {
    let row;
    try {
      row = await this.client.getAddress(this.bankAddress);
    } catch {
      return undefined;
    }
    const known = ChainSettlement.docKnownIds(doc).out;
    const attested = new Set(Object.keys(doc?.attestedOutflows || {}));
    const missing = [];
    for (const t of row.txs || []) {
      if (!t || !t.id || t.from !== this.bankAddress) continue;
      if (known.has(t.id) || attested.has(t.id)) continue;
      if (!Array.isArray(this.writer.binding?.priorLedgerIds)) continue; // binding row without an id list: nothing to judge by
      if (this._preBinding(t.id, t.ts)) continue;
      missing.push(t.id);
    }
    return missing;
  }

  /**
   * Operator review after STALE_STORE: records the listed (or all currently unaccounted) bank outflows as
   * acknowledged in the stored document, so the next writer can take over. They still show as foreign
   * outflows (holding trading) until acknowledged with ackForeignOutflows.
   */
  async attestOutflows() {
    const doc = await this.store.load();
    const missing = await this._unaccountedOutflows(doc);
    if (missing === undefined) throw new Error('minepoa did not answer; try again');
    this.writer.unblock();
    this._attestPending = missing;
    await this.tick();
    return { attested: missing, writer: this.writer.view() };
  }

  /** Read-only instance: refresh the ledger view for status/audit; never book, roll, claim or sign. */
  async _readOnlyTick() {
    await this._readShared();
    const row = await this._scanBank();
    this.foreign = this._foreignOutflows();
    this.lastTick = now();
    this.lastError = this._tickErrors.length ? this._tickErrors.join('; ') : null;
    if (this.lastError) this.lastErrorAt = now();
    return row;
  }

  /**
   * One-time binding of this store to the bank. Refused unless the store provably holds the live vault:
   * when the bank has ledger history, the stored document must already know the bank's newest outgoing
   * transfer (or, with no outgoing yet, its newest incoming one). An empty store, or an old copy, fails
   * this check and stays read-only. `recovery: true` (admin only) binds anyway after a real state loss;
   * then every bet older than the binding is held for review, never rolled.
   */
  async bindStore({ via = 'admin', recovery = false } = {}) {
    if (!this.writer.enabled) throw new Error('POA_DICE_BANK_SIGNER is not 1 on this instance');
    if (!this._loaded) throw new Error('the vault state is not loaded yet; binding waits for a successful load');
    if (!this.writer.supportsLease()) throw new Error('this vault store has no single-writer lease (use Postgres)');
    const existing = await this.store.peek(BINDING_KEY);
    if (existing) {
      if (existing.bankAddress !== this.bankAddress) throw new Error('store is already bound to a different bank');
      this.writer.binding = existing;
      if (recovery && this.writer.blocked) return { alreadyBound: true, binding: existing, ...(await this.attestOutflows()) };
      return { alreadyBound: true, binding: existing };
    }
    const row = await this.client.getAddress(this.bankAddress);
    const hist = (row.txs || []).filter((t) => t && t.id && (t.from === this.bankAddress || t.to === this.bankAddress)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const storedDoc = hist.length ? await this.store.load() : null;
    const accepted = new Set(Object.keys(storedDoc?.version === 1 ? storedDoc.inbound || {} : {}));
    // Bank ledger txs that exist before the binding and that the stored vault has not accepted: bets among
    // them are never rolled, and payouts among them are history (only this writer pays from now on).
    const priorLedgerIds = hist.map((t) => t.id).filter((id) => !accepted.has(id)).slice(0, 5000);
    if (hist.length && !recovery) {
      // Judge the document as it is stored, never this instance's in-memory copy (a read-only copy
      // scans the ledger into memory, which must not make an old store look current).
      const doc = storedDoc;
      if (!doc || doc.version !== 1) throw new Error('the store holds no vault state, but the bank has ledger history: refusing to bind (use the admin recovery binding only after a real state loss)');
      if (doc.bankAddress && doc.bankAddress !== this.bankAddress) throw new Error('the stored vault state belongs to a different bank');
      const eng = doc.engine || {};
      const outIds = new Set([...Object.keys(doc.ledgerOut || {}), ...(eng.recoveredOutflows || []).map((e) => e[0])]);
      for (const o of Object.values(doc.outbound || {})) {
        if (o.txid) outIds.add(o.txid);
        for (const x of o.superseded || []) if (x.txid) outIds.add(x.txid);
      }
      const inIds = new Set([...Object.keys(doc.inbound || {}), ...(eng.processedTxids || []).map((e) => e[0])]);
      const out = hist.find((t) => t.from === this.bankAddress);
      const knowsOut = (id) => outIds.has(id);
      const knowsIn = (id) => inIds.has(id);
      if (out ? !knowsOut(out.id) : !knowsIn(hist[0].id)) {
        throw new Error(`the stored vault state does not know the bank's newest ledger ${out ? 'outflow' : 'transfer'} (${(out || hist[0]).id.slice(0, 16)}): this is not the live store; refusing to bind`);
      }
    }
    const binding = { bankAddress: this.bankAddress, storeId: `store-${crypto.randomBytes(9).toString('hex')}`, boundAt: new Date(now()).toISOString(), boundAtMs: now(), via, recovery: Boolean(recovery), ledgerTxCount: hist.length, priorLedgerIds };
    const res = await this.store.claim(BINDING_KEY, binding);
    this.writer.binding = res.value;
    if (this.logger) this.logger(`vault store bound to bank ${this.bankAddress} (${res.value.storeId}, via ${via})`);
    return { alreadyBound: !res.claimed, binding: res.value };
  }

  /**
   * Bank outflows this vault did not create: final transfers from the bank that are not ours (no order /
   * txid of ours, not booked by recovery) AND either reference a bet or deposit this vault already settled,
   * or happened after the store binding. They hold trading until acknowledged (ackForeignOutflows).
   */
  _foreignOutflows() {
    const known = this._knownOutTxids();
    const tags = this._knownOrderTags();
    const settled = new Set();
    for (const id of this.engine.processedTxids.keys()) settled.add(String(id).slice(0, 16));
    for (const r of Object.values(this.state.inbound)) if (r.status === 'BOOKED' || r.status === 'NEEDS_REVIEW') settled.add(r.txid.slice(0, 16));
    const acks = this.state.foreignAck || {};
    const out = [];
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) {
      if (!o.final || known.has(id) || this.engine.recoveredOutflows.has(id)) continue;
      if (o.ord && tags.has(o.ord)) continue;
      const memo = String(o.memo || '');
      const ref = memo.split(':').find((part) => /^[0-9a-f]{16}$/.test(part) && settled.has(part)) || null;
      const afterBinding = Boolean(this.writer.binding) && !this._preBinding(id, o.ts);
      if (!ref && !afterBinding) continue;
      out.push({
        txid: id,
        to: o.to,
        amountPoa: o.amountPoa,
        memo: memo.slice(0, 120),
        ts: o.ts ? new Date(Number(o.ts) * 1000).toISOString() : null,
        references: ref,
        reason: ref ? 'pays a bet/transaction this vault already settled' : 'signed with the bank key after the store binding, not by this vault',
        acknowledged: acks[id] || null,
        explorer: this.client.explorerTxUrl(id)
      });
    }
    return out;
  }

  /**
   * Operator decision for foreign outflows: 'book_loss' (charge to the bankroll) or 'reimbursed' (funds
   * returned to the bank). Works on any instance: the decision is recorded in the shared store (claim
   * `foreign-ack:<txid>`) and the bank writer applies it on its next pass (immediately when this is the writer).
   */
  async ackForeignOutflows({ txids = [], mode, note = null }) {
    if (!['book_loss', 'reimbursed'].includes(mode)) throw new Error("mode must be 'book_loss' or 'reimbursed'");
    if (!Array.isArray(txids) || !txids.length) throw new Error('txids: list the foreign outflow txids to acknowledge');
    await this.tick();
    const writer = this.writer.canWrite();
    if (!writer) {
      if (this.writer.status !== 'STANDBY') throw new Error(this.writer.hold()?.reason || 'read-only');
      await this._readShared();
      if (!this._sharedFresh()) throw new Error(this._standbyHold().reason);
    }
    const list = writer ? this._foreignOutflows() : this.shared.foreignOutflows || [];
    const foreign = new Map(list.map((f) => [f.txid, f]));
    for (const id of txids) if (!foreign.has(id)) throw new Error(`${String(id).slice(0, 16)} is not a listed foreign outflow`);
    const done = [];
    for (const id of txids) {
      const res = await this.store.claim(`foreign-ack:${id}`, { txid: id, mode, at: new Date(now()).toISOString(), ...(note ? { note: String(note).slice(0, 200) } : {}) });
      done.push({ txid: id, mode: res.value.mode, ...(res.claimed ? {} : { alreadyAcknowledged: true }) });
    }
    if (!writer) {
      if (this.passMode) {
        const r = await this.maybePass({ force: true, budgetMs: 8000 }).catch(() => ({ finished: false }));
        await this._observe().catch(() => {});
        if (r.finished && this._sharedFresh()) return { acknowledged: done, appliedBy: 'settlement pass', foreign: this.shared.foreignOutflows || [] };
      }
      return { acknowledged: done, appliedBy: 'the bank writer on its next pass', foreign: list };
    }
    await this._applyForeignAcks();
    await this.flush();
    await this.tick();
    return { acknowledged: done, foreign: this._foreignOutflows() };
  }

  /** A bank payout already on the ledger for this order's bet: {txid, adopt, why} or null. */
  _ledgerPaidFor(rec) {
    const m = /^DICE1:(WIN|REFUND):([0-9a-f]{16}):/.exec(String(rec.memo || ''));
    if (!m) return null;
    const [, kind, tag] = m;
    if (kind === 'WIN') {
      const booked = this.engine.processedTxids.get(rec.sourceTxid);
      if (booked && booked.won === false) return { txid: rec.sourceTxid, adopt: false, why: 'the bet was booked as a loss' };
    }
    const mine = new Set([rec.txid, ...(rec.superseded || []).map((x) => x.txid)].filter(Boolean));
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) {
      if (mine.has(id)) continue;
      const memo = String(o.memo || '');
      if (!memo.split(':').includes(tag) || !/^DICE1:(WIN|REFUND):/.test(memo)) continue;
      const same = o.to === rec.to && toMicros(o.amountPoa) === toMicros(rec.amountPoa) && memo.startsWith(`DICE1:${kind}:${tag}:`);
      return { txid: id, adopt: same, why: same ? 'identical payout already on the ledger' : `different payout on the ledger (${o.amountPoa} POA to ${o.to})` };
    }
    return null;
  }

  // ─── Bank nonce + rejected-payout reconciler ─────────────────────────────

  /** minepoa receipt: object, null (none), undefined (could not ask, or an error body such as "origin busy"). */
  async _receipt(txid) {
    const r = await this.client.getReceipt(txid).catch(() => undefined);
    if (r === undefined || r === null) return r;
    if (typeof r !== 'object' || !r.status) return undefined;
    return r;
  }

  /**
   * The signed body this order sent: rec.body, else the store's payout claim for it. Only a body whose
   * txid, sender, recipient and amount match the order is returned.
   */
  async _sentBody(rec) {
    const ok = (b) => b && txidOf(b) === rec.txid && b.from === this.bankAddress && b.to === rec.to && toMicros(String(b.amount)) === toMicros(rec.amountPoa) && (!Number.isInteger(rec.nonce) || Number(b.nonce) === rec.nonce);
    if (ok(rec.body)) return rec.body;
    if (typeof this.store.peek !== 'function') return null;
    try {
      const v = await this.store.peek(`payout:${rec.orderId}:${rec.resigns || 0}`);
      if (v && v.txid === rec.txid && ok(v.body)) return v.body;
    } catch {
      // store unavailable: no proof this tick
    }
    return null;
  }

  /**
   * minepoa's receipt proves this payout landed: status included / final, for this txid, and the signed
   * body behind the txid pays exactly this order (recipient, amount, nonce). Fields the receipt itself
   * carries (to / amount / nonce / from) must match too. Returns the receipt or null.
   */
  async _receiptConfirms(rec) {
    if (!rec.txid) return null;
    const r = await this._receipt(rec.txid);
    if (!r || !['included', 'final', 'confirmed'].includes(String(r.status).toLowerCase())) return null;
    if (r.txid !== rec.txid) return null;
    const body = await this._sentBody(rec);
    if (!body) return null;
    if (r.to !== undefined && r.to !== rec.to) return null;
    if (r.from !== undefined && r.from !== this.bankAddress) return null;
    if (r.amount !== undefined && toMicros(String(r.amount)) !== toMicros(rec.amountPoa)) return null;
    if (r.nonce !== undefined && Number(r.nonce) !== Number(body.nonce)) return null;
    return r;
  }

  /**
   * Next bank nonce without the explorer: the highest nonce among the bank's own transactions that minepoa
   * confirmed (CONFIRMED orders, SENT ones with an included / final receipt, bank txs already read from the
   * ledger), and minepoa's own next_nonce answers, +1. null when nothing is known. Two instances can still
   * never sign the same nonce (bank-nonce claims), our own live bodies floor it (_localNonceFloor), and a
   * nonce minepoa says is used is only re-signed with proof (rejected-payout reconciler).
   */
  async _nonceFromReceipts() {
    let best = null;
    const bump = (n) => {
      if (Number.isInteger(n) && n > 0 && (best === null || n > best)) best = n;
    };
    for (const o of Object.values(this.state.outbound)) {
      if (o.recoveredFromLedger || !Number.isInteger(o.nonce) || !o.txid) continue;
      if (o.status === 'CONFIRMED') bump(o.nonce + 1);
      else if (o.status === 'SENT') {
        const r = await this._receipt(o.txid);
        if (r && r.txid === o.txid && ['included', 'final', 'confirmed'].includes(String(r.status).toLowerCase())) {
          bump(o.nonce + 1);
          bump(Number(r.next_nonce));
        }
      }
    }
    for (const n of this._txNonce.values()) bump(n + 1);
    bump(Number(this.state.bankNonce));
    return best;
  }

  /** body.nonce of a bank tx on the ledger (cached; nonces are immutable). undefined = could not ask. */
  async _nonceOfTx(txid) {
    if (this._txNonce.has(txid)) return this._txNonce.get(txid);
    const tx = await this.client.getTx(txid);
    if (!tx || tx.invalid) return null;
    const n = Number(tx.body?.nonce);
    if (!Number.isInteger(n) || (tx.from && tx.from !== this.bankAddress)) return null;
    this._txNonce.set(txid, n);
    return n;
  }

  /**
   * Next bank nonce according to minepoa: highest nonce among the bank's recent sends on the ledger, +1.
   * Throws when minepoa cannot answer (never guessed from local state alone).
   */
  async _chainNextNonce() {
    const row = await this.client.getAddress(this.bankAddress);
    const sent = (row.txs || []).filter((t) => t && t.id && t.from === this.bankAddress).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, this.nonceScanDepth);
    let max = 0;
    for (const t of sent) {
      const n = await this._nonceOfTx(t.id);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return max + 1;
  }

  /** Nonces our own live bodies already hold (the explorer's address page lags the open epoch). */
  _localNonceFloor() {
    let floor = 0;
    for (const o of Object.values(this.state.outbound)) {
      if (o.recoveredFromLedger || !Number.isInteger(o.nonce)) continue;
      if (o.status === 'SIGNED' || o.status === 'SENT' || o.status === 'CONFIRMED') floor = Math.max(floor, o.nonce + 1);
    }
    return floor;
  }

  /**
   * The nonce for this order's next body. Read from minepoa every time, floored by our own live bodies and
   * by what minepoa said it expects, then reserved with an atomic store claim (bank-nonce:<n>) so two
   * instances can never sign two different payouts with the same nonce.
   */
  async _chooseBankNonce(rec) {
    const rule = rec.nonceRule || {};
    if (Number.isInteger(rule.fixed)) {
      // Same nonce as the rejected body: at most one of the two can ever land.
      const res = await this._persist.claim(`bank-nonce:${rule.fixed}`, { orderId: rec.orderId, gen: rec.resigns || 0, at: now() });
      if (!res.claimed && res.value?.orderId !== rec.orderId) throw new Error(`nonce ${rule.fixed} is reserved by order ${res.value?.orderId}`);
      return rule.fixed;
    }
    let chainNext;
    try {
      chainNext = await this._chainNextNonce();
    } catch (err) {
      if (!isLedgerBusy(err)) throw err;
      const fromReceipts = await this._nonceFromReceipts();
      if (fromReceipts === null) throw err;
      chainNext = fromReceipts;
      if (this.logger) this.logger(`bank nonce from receipts (explorer busy): ${fromReceipts}`);
    }
    let n = Math.max(chainNext, this._localNonceFloor(), Number.isInteger(rule.floor) ? rule.floor : 0);
    for (let i = 0; i < 64; i++, n++) {
      const res = await this._persist.claim(`bank-nonce:${n}`, { orderId: rec.orderId, gen: rec.resigns || 0, at: now() });
      if (res.claimed || res.value?.orderId === rec.orderId) return n;
    }
    throw new Error('no free bank nonce within 64 of the ledger tip');
  }

  /** A previous body of this order that is on the ledger: txid, null (none), undefined (could not ask). */
  async _landedSuperseded(rec) {
    for (const s of rec.superseded || []) {
      if (!s.txid) continue;
      const tx = await this.client.getTx(s.txid).catch(() => undefined);
      if (tx === undefined) return undefined;
      if (tx && !tx.invalid) return s.txid;
    }
    return null;
  }

  _adoptLanded(rec, txid) {
    if (rec.txid && rec.txid !== txid) rec.superseded.push({ txid: rec.txid, nonce: rec.nonce, error: 'an earlier body of this payout landed instead', reason: 'EARLIER_BODY_LANDED', at: now() });
    rec.superseded = rec.superseded.filter((s) => s.txid !== txid);
    rec.txid = txid;
    rec.nonce = this._txNonce.get(txid) ?? null;
    rec.body = null;
    rec.status = 'SENT';
    rec.sentAt = now();
    rec.rejection = null;
    rec.nonceRule = null;
    rec.lastError = null;
    this._save();
    this.engine.markOutboundSent(rec.orderId, rec.txid, 'SENT');
    this._emit('settlement.updated', this._outboundView(rec));
  }

  /**
   * Which final bank tx used `nonce` (other than `excludeTxid`)? txid, null (none found), undefined (could not ask).
   * Proof that a rejected body's nonce is consumed, i.e. that body can never land.
   */
  async _nonceConsumer(nonce, excludeTxid) {
    const ids = new Set();
    for (const o of Object.values(this.state.outbound)) {
      if (o.txid && o.nonce === nonce) ids.add(o.txid);
      for (const s of o.superseded || []) if (s.txid && s.nonce === nonce) ids.add(s.txid);
    }
    try {
      const row = await this.client.getAddress(this.bankAddress);
      for (const t of row.txs || []) if (t && t.id && t.from === this.bankAddress) ids.add(t.id);
    } catch {
      return undefined;
    }
    ids.delete(excludeTxid);
    for (const id of ids) {
      let tx;
      try {
        tx = await this.client.getTx(id);
      } catch {
        return undefined;
      }
      if (!tx || tx.invalid || !this._confirmed(tx)) continue;
      const n = Number(tx.body?.nonce);
      if (Number.isInteger(n)) this._txNonce.set(id, n);
      if (n === nonce && (tx.from || tx.body?.from) === this.bankAddress) return id;
    }
    return null;
  }

  /**
   * SENT payouts that never landed and REJECTED ones. A body is re-signed only when minepoa definitively
   * rejected it on `rejectConfirmations` separate checks AND it is absent from the ledger every time AND it
   * provably cannot land later:
   *   - bad nonce, minepoa expects a HIGHER nonce: the old nonce must be used by another final bank tx
   *     (found on the ledger); the payout is re-signed with the nonce minepoa expects (or the ledger tip).
   *   - bad nonce, minepoa expects a LOWER nonce (gap): never re-signed; the same body is resent once the
   *     bank's next nonce reaches it.
   *   - any other definitive rejection: re-signed with the SAME nonce, so at most one body can ever land.
   * Transient answers (explorer unreachable / busy, ledger outage) reset the count. The old txid stays
   * linked in `superseded` for audit.
   */
  async _reconcilePayouts(recs) {
    if (this.ledgerProbe && this.ledgerProbe.hold()) return; // during an outage nothing counts as evidence
    for (const rec of recs) {
      if (!rec.txid || rec.recoveredFromLedger) continue;
      if (rec.status === 'SENT') {
        if (now() - (rec.sentAt || 0) < this.sentGraceMs) continue;
        if (rec.nextReceiptCheckAt && now() < rec.nextReceiptCheckAt) continue;
        rec.nextReceiptCheckAt = now() + this.rejectCheckIntervalMs;
        const receipt = await this._receipt(rec.txid);
        if (!isRejectedReceipt(receipt)) {
          await this._maybeRebroadcast(rec, receipt);
          continue;
        }
        const tx = await this.client.getTx(rec.txid).catch(() => undefined);
        if (tx !== null) continue; // on the ledger after all, or the explorer could not say
        this._markRejected(rec, String(receipt.error || 'rejected'), 'receipt');
        continue;
      }
      if (rec.status === 'REJECTED') await this._checkRejected(rec);
    }
  }

  /**
   * A SENT payout the ledger has not seen after rebroadcastAfterMs (no receipt, explorer says unknown):
   * send the SAME signed body again (same txid, same nonce). Never re-signed here: a new body or nonce
   * only comes from the rejected-payout reconciler, after minepoa proves the old one can never land.
   */
  async _maybeRebroadcast(rec, receipt) {
    if (!rec.body || rec.recoveredFromLedger || txidOf(rec.body) !== rec.txid) return false;
    if (receipt !== null) return false; // included / pending (read node behind), or no answer: not lost
    if (now() - (rec.lastBroadcastAt || rec.sentAt || 0) < this.rebroadcastAfterMs) return false;
    if (rec.nextRebroadcastAt && now() < rec.nextRebroadcastAt) return false;
    const seen = await this.client.getTx(rec.txid).catch(() => undefined);
    if (seen !== null) return false; // on the ledger, or the explorer cannot say: never act on "unknown"
    rec.rebroadcasts = (rec.rebroadcasts || 0) + 1;
    rec.lastBroadcastAt = now();
    try {
      await this.client.submitTx(rec.body);
      rec.lastError = null;
      if (this.logger) this.logger(`payout ${rec.orderId} rebroadcast (same body ${rec.txid.slice(0, 16)}, nonce ${rec.nonce})`);
    } catch (err) {
      // Best effort only: a refusal here is judged by the receipt checks above, never by this call.
      rec.lastError = `rebroadcast: ${String(err.message || err).slice(0, 160)}`;
      rec.nextRebroadcastAt = this._payoutRetryAt(rec.rebroadcasts, err);
      this.ledgerProbe?.reportFailure('payout rebroadcast', err);
    }
    this._save();
    this._emit('settlement.updated', this._outboundView(rec));
    return true;
  }

  async _checkRejected(rec) {
    const r = rec.rejection || (rec.rejection = { txid: rec.txid, nonce: rec.nonce, error: 'rejected', source: 'unknown', expected: null, kind: null, firstAt: now(), lastCheckAt: 0, checks: 0, consumedBy: null, lastTransient: null });
    if (r.checks > 0 && now() - r.lastCheckAt < this.rejectCheckIntervalMs) return;
    r.lastCheckAt = now();
    const transient = (why) => {
      r.checks = 0;
      r.lastTransient = why;
      this._save();
    };
    // 1. never act while any body of this payout might be on the ledger
    const tx = await this.client.getTx(rec.txid).catch(() => undefined);
    if (tx === undefined) return transient('explorer could not answer for the rejected txid');
    if (tx && !tx.invalid) return this._adoptLanded(rec, rec.txid);
    const landed = await this._landedSuperseded(rec);
    if (landed === undefined) return transient('explorer could not answer for an earlier body');
    if (landed) return this._adoptLanded(rec, landed);
    // 2. minepoa must still say rejected
    const receipt = await this._receipt(rec.txid);
    if (receipt === undefined) return transient('receipt unavailable');
    if (receipt && !isRejectedReceipt(receipt)) {
      // the node now reports it as pending / included: back to waiting for confirmation
      rec.status = 'SENT';
      rec.sentAt = now();
      rec.rejection = null;
      rec.lastError = null;
      this._save();
      return;
    }
    if (!receipt && r.source !== 'submit') return transient('no receipt for the txid');
    if (receipt?.error) {
      r.error = String(receipt.error);
      const e = parseExpectedNonce(r.error);
      if (e !== null) r.expected = e;
    }
    r.checks += 1;
    r.lastTransient = null;
    this._save();
    if (r.checks < this.rejectConfirmations) return;
    // 3. decide
    const E = r.expected;
    const old = rec.nonce;
    if (Number.isInteger(E) && Number.isInteger(old) && E < old) {
      r.kind = 'NONCE_GAP';
      rec.lastError = `minepoa expects bank nonce ${E}; this payout holds ${old}. It is resent unchanged once the gap is filled.`;
      const next = await this._chainNextNonce().catch(() => null);
      if (next === old) {
        rec.status = 'SIGNED';
        rec.forceRebroadcast = true;
        rec.nextAttemptAt = 0;
      }
      this._save();
      return;
    }
    let rule;
    if (Number.isInteger(E) && Number.isInteger(old) && E > old) {
      const consumer = await this._nonceConsumer(old, rec.txid);
      if (consumer === undefined) return transient('explorer could not answer while proving the nonce is used');
      if (!consumer) {
        r.kind = 'NONCE_USED_UNPROVEN';
        rec.lastError = `minepoa says nonce ${old} is used, but no final bank tx with that nonce was found yet; not re-signed.`;
        this._save();
        return;
      }
      if (rec.superseded.some((s) => s.txid === consumer)) return this._adoptLanded(rec, consumer);
      r.kind = 'NONCE_USED';
      r.consumedBy = consumer;
      rule = { floor: E };
    } else {
      r.kind = 'REJECTED';
      rule = Number.isInteger(old) ? { fixed: old } : {};
    }
    this._resign(rec, rule);
  }

  _resign(rec, rule) {
    const r = rec.rejection || {};
    rec.superseded.push({ txid: rec.txid, nonce: rec.nonce, error: r.error || rec.lastError, reason: r.kind || 'REJECTED', consumedBy: r.consumedBy || null, rejectedAt: r.firstAt || now(), at: now() });
    rec.resigns = (rec.resigns || 0) + 1;
    rec.nonceRule = rule;
    rec.txid = null;
    rec.body = null;
    rec.nonce = null;
    rec.rejection = null;
    rec.forceRebroadcast = false;
    this._tip = null; // fresh parents too
    rec.status = rec.resigns > this.maxResign ? 'FAILED' : 'QUEUED';
    rec.nextAttemptAt = 0;
    if (rec.status === 'FAILED') {
      rec.lastError = `payout rejected ${rec.resigns} times; operator must review`;
      this._failEngine(rec);
    }
    if (this.logger) this.logger(`payout ${rec.orderId} re-signing (${rule.fixed !== undefined ? `same nonce ${rule.fixed}` : `nonce >= ${rule.floor}`})`);
    this._save();
    this._emit('settlement.updated', this._outboundView(rec));
  }

  /** Payouts that are owed but not on their way: rejected bodies, and SENT ones unconfirmed for too long. */
  stuckPayouts() {
    const out = [];
    for (const o of Object.values(this.state.outbound)) {
      const staleSent = o.status === 'SENT' && o.sentAt && now() - o.sentAt > this.stuckAfterMs;
      if (o.status !== 'REJECTED' && !staleSent) continue;
      out.push({
        orderId: o.orderId,
        to: o.to,
        amountPoa: o.amountPoa,
        status: o.status === 'REJECTED' ? 'REJECTED' : 'SENT_UNCONFIRMED_STALE',
        txid: o.txid,
        nonce: o.nonce,
        error: o.rejection?.error || o.lastError || null,
        kind: o.rejection?.kind || null,
        rejectionChecks: o.rejection?.checks ?? null,
        since: new Date(o.rejection?.firstAt || o.sentAt).toISOString(),
        superseded: o.superseded || []
      });
    }
    return out;
  }

  _outboundView(rec) {
    return {
      direction: 'outbound',
      orderId: rec.orderId,
      kind: rec.kind,
      sourceTxid: rec.sourceTxid,
      to: rec.to,
      amountPoa: rec.amountPoa,
      status: rec.status === 'QUEUED' || rec.status === 'WAITING_FUNDS' || rec.status === 'SIGNED' || rec.status === 'REJECTED' ? 'PENDING' : rec.status,
      rawStatus: rec.status,
      txid: rec.txid,
      explorer: rec.txid ? this.client.explorerTxUrl(rec.txid) : null,
      attempts: rec.attempts,
      lastError: rec.lastError,
      rejection: rec.rejection ? { error: rec.rejection.error, kind: rec.rejection.kind, expectedNonce: rec.rejection.expected, checks: rec.rejection.checks } : null,
      superseded: rec.superseded
    };
  }

  // ─── Loop ─────────────────────────────────────────────────────────────────

  tick() {
    if (this._tickPromise) return this._tickPromise;
    this._tickPromise = (async () => {
      // Yield first: an early return must not run `finally` before this._tickPromise is assigned
      // (that would leave a settled promise in place and block every later tick).
      await null;
      if (this._observePromise) await this._observePromise.catch(() => {}); // never mix a replica reload into a pass
      this._tickErrors = [];
      let passStarted = false;
      try {
        if (this.fatalError) return;
        if (!this._loaded) {
          // Fail closed: nothing but the load is attempted until the vault document is loaded.
          if (this.vaultLoad.status === 'LOADING') {
            await this._loadPromise.catch(() => {});
            if (!this._loaded) return;
          } else if (this.vaultLoad.nextRetryAt && now() < this.vaultLoad.nextRetryAt) {
            return;
          } else {
            await this._retryLoad().catch(() => {});
            if (!this._loaded) return;
          }
        }
        await this.ready();
        if (this.ledgerProbe) await this.ledgerProbe.maybeProbe().catch(() => {});
        let leader = await this.writer.refresh();
        if (!leader && this.writer.status === 'UNBOUND' && this.bindOnBoot) {
          try {
            await this.bindStore({ via: 'env' });
          } catch (err) {
            this._tickErrors.push(`store binding: ${err.message}`);
          }
          leader = await this.writer.refresh();
        }
        if (!leader) {
          this._leaderToken = null;
          if (this.writer.status === 'STANDBY') await this._standbyTick();
          else await this._readOnlyTick();
          return;
        }
        passStarted = true;
        this.passes.started += 1;
        this.passes.lastStartedAt = now();
        if (this._leaderToken !== this.writer.lease.token) {
          // Newly the writer (or the lease changed hands): start from the shared document, not our copy,
          // and only if that document accounts for every bank outflow on the ledger.
          const doc = await this._reloadFromStore();
          // Pass mode: re-taking the lease right after our own pass (nobody held it in between, the
          // document is exactly what we left) is the same writer continuing; the check already passed.
          const continuing = Boolean(this._lastPass && doc && this._lastPass.holder === this.writer.holderId && this.writer.lease.token === this._lastPass.token + 1 && this._loadedSavedAt === this._lastPass.savedAt);
          let missing = continuing ? [] : await this._unaccountedOutflows(doc);
          if (missing === undefined && (await this._handoverFromFreshStatus(doc))) {
            // minepoa's explorer is busy: the document is exactly the one the last writer published, and
            // that was recent, so it is not an old copy. The full ledger check runs on the next handover.
            missing = [];
            this._tickErrors.push('writer takeover: explorer busy; continued from the last published document');
          }
          const attest = new Set(this._attestPending || []);
          this._attestPending = null;
          const unexplained = (missing || []).filter((id) => !attest.has(id));
          if (missing === undefined || unexplained.length) {
            if (missing === undefined) {
              this._tickErrors.push('writer takeover: minepoa did not answer; retrying');
              await this.writer.release();
            } else {
              const msg = `stored vault does not account for bank transfer(s) ${unexplained.map((id) => id.slice(0, 16)).join(', ')}: refusing to sign (old copy of the store, or a transfer made outside this vault)`;
              this._tickErrors.push(`writer takeover: ${msg}`);
              await this.writer.block(msg, unexplained);
            }
            await this._readOnlyTick();
            return;
          }
          if (attest.size) {
            this.state.attestedOutflows = this.state.attestedOutflows || {};
            for (const id of attest) this.state.attestedOutflows[id] = { at: new Date(now()).toISOString() };
            this._save();
          }
          this._leaderToken = this.writer.lease.token;
          this._standbyLocal.clear();
        }
        this.writer.tokenAtTickStart = this.writer.lease.token;
        await this._syncSeed();
        const row = await this._scanBank();
        await this._confirmInbound();
        await this._applyForeignAcks().catch((err) => this._tickErrors.push(`foreign acks: ${err.message}`));
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
        // A pass that only met a slow / busy minepoa (and fell back to receipts or the last trusted read)
        // still completed: slow is not down. Any other error makes it not good.
        const hardErrors = this._tickErrors.filter((e) => !isLedgerBusy(e));
        this.lastGoodTick = hardErrors.length ? this.lastGoodTick : now();
        await this._publishStatus();
        this.writer.tokenAtTickStart = null;
        this.passes.completed += 1;
        this.passes.lastCompletedAt = now();
        this.passes.lastMs = now() - this.passes.lastStartedAt;
        if (this.passMode && this.writer.canWrite()) {
          // Hand the lease back: the next pass (any instance) can start at once instead of waiting for
          // this instance's lease to expire while it is frozen between requests.
          this._lastPass = { holder: this.writer.holderId, token: this.writer.lease.token, savedAt: this.state.savedAt ?? null, at: now() };
          await this.writer.release();
        }
      } catch (err) {
        this.lastError = String(err.message || err);
        this.lastErrorAt = now();
        if (this.logger) this.logger(`settlement tick error: ${this.lastError}`);
        if (this.passMode && passStarted && this.writer.status === 'LEADER') {
          this._lastPass = null; // the next writer reloads and re-checks the stored vault
          await this.writer.release().catch(() => {});
        }
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
    if (!this.writer.canWrite() && this.writer.status === 'STANDBY') {
      // Standby: the writer's published limit; reservations against it are shared (reserveCapacity).
      const c = this.shared?.coverage;
      if (!c || !c.known) return { known: false, code: c?.code || 'BANK_BALANCE_UNKNOWN', reason: c?.reason || 'The bank writer has not published the bank\'s free funds yet; bets are paused.' };
      const limit = BigInt(c.limitMicros);
      return { known: true, limitMicros: limit, baseMicros: limit, source: 'writer-status' };
    }
    const row = this._lastRow;
    if (!row || typeof row.effectiveMicros !== 'bigint') return { known: false, code: 'BANK_BALANCE_UNKNOWN', reason: 'The bank balance on minepoa is unknown right now; bets are paused until it can be read.' };
    if (now() - this._lastRowAt > this.balanceStaleMs) return { known: false, code: 'BANK_BALANCE_STALE', reason: `The bank balance was last read ${Math.round((now() - this._lastRowAt) / 1000)}s ago; bets are paused until it is refreshed.` };
    let pendingOut = 0n;
    for (const o of Object.values(this.state.outbound)) if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT' && o.status !== 'SIGNED') pendingOut += toMicros(o.amountPoa);
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
    if (this.writer.status === 'STANDBY') {
      if (now() - this._sharedReadAt > STANDBY_STATUS_REFRESH_MS) await (this.passMode ? this._observe() : this.tick()).catch(() => {});
      return;
    }
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
    const standby = this.writer.status === 'STANDBY';
    if (standby && this.passMode) await this._observe(STANDBY_STATUS_REFRESH_MS).catch(() => {});
    else if (standby ? now() - this._sharedReadAt > STANDBY_STATUS_REFRESH_MS : !this.reconcile.at) await this.tick().catch(() => {});
    if (this.ledgerProbe) await this.ledgerProbe.maybeProbe().catch(() => {});
    return this.tradingHold();
  }

  /**
   * null when trading is open; otherwise { status, reason } (bets / withdrawals refused).
   * RECONCILING / SOLVENCY_HOLD (books vs ledger) take precedence over LEDGER_UNAVAILABLE.
   */
  tradingHold() {
    if (!this._loaded) return { status: 'SIGNER_READ_ONLY', reason: `Vault state is not loaded yet (${this.vaultLoad.lastError || 'loading'}). Read-only until a load succeeds; retried automatically.`, writer: 'VAULT_NOT_LOADED' };
    if (!this.writer.canWrite() && this.writer.status === 'STANDBY') return this._standbyHold();
    const wh = this.writer.hold();
    if (wh) return wh;
    return this._leaderHold();
  }

  /** Standby: the writer's published hold, or NO_ACTIVE_LEADER when its status is missing or stale. */
  _standbyHold() {
    if (!this._sharedFresh()) {
      const age = this.shared?.at ? `${Math.round((now() - Number(this.shared.at)) / 1000)} s ago` : 'never';
      const good = this.shared?.goodAt ? `${Math.round((now() - Number(this.shared.goodAt)) / 1000)} s ago` : 'never';
      return { status: NO_ACTIVE_LEADER, reason: `No settlement pass has completed recently (last good pass: ${good}; last status: ${age}; limit ${Math.round(this.leaderStatusMaxAgeMs / 1000)} s). Bets and withdrawals are refused until one does.`, writer: NO_ACTIVE_LEADER };
    }
    if (this.shared.hold) return { status: this.shared.hold.status, reason: this.shared.hold.reason };
    return this.ledgerProbe ? this.ledgerProbe.hold() : null;
  }

  /** The writer's own hold: reconciliation state, then the ledger probe. */
  _leaderHold() {
    if (this.reconcile && this.reconcile.status !== 'OK') {
      const st = this.reconcile.status;
      return { status: st === 'SOLVENCY_HOLD' || st === 'FOREIGN_OUTFLOW_HOLD' ? st : 'RECONCILING', reason: this.reconcile.reason };
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

  /**
   * True when a bank ledger tx predates this store's binding (it was on the ledger when the store was bound
   * and the stored vault had not accepted it). Falls back to the binding time for older binding rows.
   */
  _preBinding(txid, ts) {
    const b = this.writer.binding;
    if (!b) return true;
    if (Array.isArray(b.priorLedgerIds)) {
      if (!this._priorIds || this._priorIdsOf !== b) {
        this._priorIds = new Set(b.priorLedgerIds);
        this._priorIdsOf = b;
      }
      return this._priorIds.has(txid);
    }
    return !(Number(ts || 0) >= Math.floor(Number(b.boundAtMs || 0) / 1000));
  }

  /**
   * 16-hex txid prefixes referenced by the memos of the bank's outgoing transfers (WIN/REFUND/PAYOUT/...).
   * Once the store is bound, only transfers from before the binding count: after it, only this writer
   * pays, so any other bank payout is a foreign outflow and never marks a bet as settled.
   */
  _outflowRefs() {
    const refs = new Set();
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) {
      if (this.writer.binding && !this._preBinding(id, o.ts)) continue;
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
          if (this.writer.binding && !this._preBinding(id, o.ts)) continue; // after the binding only this writer pays
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
      this.foreign = this._foreignOutflows();
      const foreignIds = new Set(this.foreign.map((f) => f.txid));
      for (const [id, o] of outs) {
        if (known.has(id) || (o.ord && tags.has(o.ord)) || foreignIds.has(id)) continue;
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
      // 3. the books must be covered by the confirmed on-chain balance. A signed or sent payout that the
      //    ledger view does not show yet is subtracted from the balance (in flight) and is NOT counted as
      //    owed again, so a payout in flight never trips SOLVENCY_HOLD.
      //    A queued refund is owed AND its deposit is in the balance, so it is covered: it counts once.
      const solvency = () => {
        let pendingOut = 0n;
        for (const o of Object.values(this.state.outbound)) if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT' && o.status !== 'SIGNED') pendingOut += toMicros(o.amountPoa);
        for (const item of this.engine.outboundQueue) if (item.status === 'PENDING' && !this.state.outbound[item.orderId]) pendingOut += BigInt(item.amountMicros);
        return { required: this.engine.bankNavMicros + this.engine.devReserveMicros + this.engine.incentivePoolMicros + pendingOut, available: row.effectiveMicros - this._inFlightOutMicros(row.listedIds) };
      };
      let { required, available } = solvency();
      if (available < required && this._repairHalfAppliedRefunds(required - available)) ({ required, available } = solvency());
      const inReview = Object.values(this.state.inbound).filter((r) => r.status === 'NEEDS_REVIEW').map((r) => r.txid);
      const audit = { onChainPoa: fromMicros(available < 0n ? 0n : available), requiredPoa: fromMicros(required), ok: available >= required };
      audit.foreignOutflows = this.foreign.length;
      if (!audit.ok) {
        return set('SOLVENCY_HOLD', `Books (${fromMicros(required)} POA) exceed the confirmed on-chain bank balance (${fromMicros(available < 0n ? 0n : available)} POA); bets and withdrawals are paused until reconciled.`, { inReview, audit, recovered: this.reconcile.recovered + recovered });
      }
      const unacked = this.foreign.filter((f) => !f.acknowledged);
      if (unacked.length) {
        return set('FOREIGN_OUTFLOW_HOLD', `${unacked.length} bank transfer(s) on the ledger were not created by this vault (${unacked.map((f) => f.txid.slice(0, 16)).join(', ')}); bets and withdrawals are paused until an operator acknowledges them.`, { inReview, audit, recovered: this.reconcile.recovered + recovered });
      }
      return set('OK', null, { inReview, audit, recovered: this.reconcile.recovered + recovered });
    } catch (err) {
      this._tickErrors.push(`reconcile: ${err.message}`);
      return set(prevStatus === 'OK' ? 'OK' : 'PENDING', prevStatus === 'OK' ? null : `Reconciliation could not finish (${err.message}); retrying.`);
    }
  }

  /**
   * Bets refused by the accounting invariant and refunded, whose settlement had already booked the wager
   * into the books (settleBet was not all-or-nothing before 2026-10-26): the wager was counted twice
   * (in NAV and fees, and as the queued refund). Undo the half-applied loss once, only for the writer,
   * only while the books exceed the balance by no more than those wagers, and never when a WIN payout
   * exists for the bet. Returns how many were repaired.
   */
  _repairHalfAppliedRefunds(shortfallMicros) {
    if (!this.writer.canWrite()) return 0;
    const cands = Object.values(this.state.inbound).filter(
      (r) => r.action === 'BET' && r.status === 'BOOKED' && !r.halfApplyRepaired && r.result?.action === 'REFUND_QUEUED' && /^Accounting invariant failed/.test(String(r.result?.reason || ''))
    );
    if (!cands.length) return 0;
    let total = 0n;
    const ok = [];
    for (const r of cands) {
      const win = Object.values(this.state.outbound).some((o) => o.sourceTxid === r.txid && o.kind === 'BET_WIN_PAYOUT') || this.engine.outboundQueue.some((o) => o.sourceTxid === r.txid && o.kind === 'BET_WIN_PAYOUT');
      const receipt = this.engine.processedTxids.get(r.txid);
      if (win || !receipt || receipt.action !== 'REFUND_QUEUED') continue;
      ok.push(r);
      total += toMicros(r.amountPoa);
    }
    if (!ok.length || shortfallMicros > total) return 0; // the gap is not (only) these wagers: leave it to the hold
    for (const r of ok) {
      const done = this.engine.revertHalfAppliedLoss({ betTxid: r.txid, wagerMicros: toMicros(r.amountPoa) });
      r.halfApplyRepaired = { at: now(), ...done };
      if (this.logger) this.logger(`reconcile: bet ${r.txid.slice(0, 16)} was refunded but its wager was also booked; booking undone (${done.wagerPoa} POA)`);
    }
    this._save();
    return ok.length;
  }

  summary() {
    const count = (list, key) => list.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
    const outs = Object.values(this.state.outbound);
    const ins = Object.values(this.state.inbound);
    const fromWriter = !this.writer.canWrite() && this.writer.status === 'STANDBY' && this._sharedFresh() ? this.shared : null;
    const rec = fromWriter ? fromWriter.reconcile || {} : this.reconcile;
    return {
      mode: 'chain',
      bankAddress: this.bankAddress,
      vaultLoad: this.loadView(),
      confirmPolicy: this.confirmPolicy,
      store: this.store.kind,
      storeDurable: this.store.durable !== false,
      lastTick: this.lastTick ? new Date(this.lastTick).toISOString() : null,
      lastGoodTick: this.lastGoodTick ? new Date(this.lastGoodTick).toISOString() : null,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      onChainBankBalancePoa: fromWriter ? fromWriter.onChainBankBalancePoa : this.lastBankBalance?.balance ?? null,
      bankBalance: this.lastBankBalance,
      stuckPayouts: this.stuckPayouts(),
      writer: this.writer.view(),
      leader: this.leaderView(),
      foreignOutflows: fromWriter ? fromWriter.foreignOutflows || [] : this.foreign,
      ledgerIndexComplete: this.ledgerIndexComplete,
      reconcile: { status: rec.status ?? null, reason: rec.reason ?? null, at: rec.at ? new Date(rec.at).toISOString() : null, inReview: rec.inReview, audit: rec.audit, ...(fromWriter ? { source: 'writer-status' } : {}) },
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
    // Bank payouts this vault made that the bank read does not show yet (signed, sent, or confirmed after
    // the read) are subtracted from the balance and not counted as owed: each payout is counted once.
    const sentUnconfirmed = this._inFlightOutMicros(row.listedIds);
    const onChain = row.effectiveMicros - sentUnconfirmed;
    const unconfirmedIn = 0n; // the effective balance only counts FINAL inbound
    let pendingOut = 0n;
    for (const o of Object.values(this.state.outbound)) if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT' && o.status !== 'SIGNED') pendingOut += toMicros(o.amountPoa);
    for (const item of this.engine.outboundQueue) if (item.status === 'PENDING' && !this.state.outbound[item.orderId]) pendingOut += BigInt(item.amountMicros);
    const booked = this.engine.bankNavMicros + this.engine.devReserveMicros + this.engine.incentivePoolMicros;
    const required = booked + pendingOut;
    const confirmedOnChain = onChain - unconfirmedIn;
    const delta = confirmedOnChain - required;
    const stuck = this.stuckPayouts();
    let rejectedMicros = 0n;
    for (const o of Object.values(this.state.outbound)) if (o.status === 'REJECTED') rejectedMicros += toMicros(o.amountPoa);
    return {
      ok: delta >= 0n,
      bankAddress: this.bankAddress,
      onChainBalancePoa: fromMicros(onChain < 0n ? 0n : onChain),
      balanceFrom: row.fromTrusted ? 'last-trusted-read' : 'ledger',
      trustedBalanceAt: row.fromTrusted ? new Date(row.trustedAt).toISOString() : null,
      trustedBalanceAgeMs: row.fromTrusted ? Math.max(0, now() - row.trustedAt) : null,
      unconfirmedInboundPoa: fromMicros(unconfirmedIn),
      confirmedOnChainPoa: fromMicros(confirmedOnChain < 0n ? 0n : confirmedOnChain),
      internal: {
        bankNavPoa: fromMicros(this.engine.bankNavMicros),
        devReserveUnpaidPoa: fromMicros(this.engine.devReserveMicros),
        incentivePoolPoa: fromMicros(this.engine.incentivePoolMicros),
        // owed and NOT on its way (includes rejected payouts, listed separately below)
        outboundNotYetSentPoa: fromMicros(pendingOut),
        outboundRejectedPoa: fromMicros(rejectedMicros),
        outboundSentUnconfirmedPoa: fromMicros(sentUnconfirmed),
        lockedCollateralPoa: fromMicros(this.engine.lockedCollateralMicros),
        lockedCollateralHeal: this.engine.lockHeal || null
      },
      payoutsOk: stuck.length === 0,
      stuckPayouts: stuck,
      writer: this.writer.view(),
      foreignOutflowsOk: this._foreignOutflows().every((f) => f.acknowledged),
      foreignOutflows: this._foreignOutflows(),
      ledgerOnlyBets: Object.values(this.state.inbound).filter((r) => r.status === 'NEEDS_REVIEW' && r.action === 'BET').map((r) => ({ txid: r.txid, from: r.from, amountPoa: r.amountPoa, reason: r.reviewReason || 'PREDATES_STATE', error: r.error })),
      refusedDuplicatePayouts: Object.values(this.state.outbound).filter((o) => o.status === 'REFUSED_DUPLICATE').map((o) => ({ orderId: o.orderId, to: o.to, amountPoa: o.amountPoa, duplicateOf: o.duplicateOf, error: o.lastError })),
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
