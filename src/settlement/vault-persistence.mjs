// @ts-nocheck
/**
 * settlement/vault-persistence.mjs — Vault loading, coalesced writes, O(1) indexes,
 * play-time caching, and hot-window vault compaction.
 */
import { computePlayTimes } from '../play-time.mjs';
import { bankHistoryOf, compactBankHistory } from '../bank-history.mjs';
import { pushLoadPhase } from '../settlement-store.mjs';
import { OPEN_IN, TERMINAL_OUT, now } from './constants.mjs';

export const vaultPersistenceMethods = {
  _markLoaded() {
    this._loaded = true;
    this.vaultLoad = { ...this.vaultLoad, status: 'LOADED', nextRetryAt: null, loadedAt: new Date(now()).toISOString() };
    if (this.onLoadStateChange) this.onLoadStateChange(this.vaultLoad);
  },

  /** Copy the store's last connect / schema_init / vault_load attempt, or time this load when the store did not. */
  _captureLoadPhases(startedAt, err) {
    const fromStore = this.store && Array.isArray(this.store.lastLoadPhases) ? this.store.lastLoadPhases : null;
    const phases =
      fromStore && fromStore.length
        ? fromStore.map((phase) => ({
            phase: String(phase.phase),
            durationMs: Number(phase.durationMs) || 0,
            ...(phase.code ? { code: String(phase.code) } : {}),
            ...(phase.message ? { message: String(phase.message) } : {})
          }))
        : [pushLoadPhase([], 'vault_load', startedAt, err)];
    this.vaultLoad = { ...this.vaultLoad, phases };
  },

  /** One load attempt: applies the document on success; records the error and the next retry on failure. */
  _trackLoad(promise, startedAt = Date.now()) {
    this.vaultLoad.attempts += 1;
    this.vaultLoad.status = 'LOADING';
    const p = Promise.resolve(promise).then(
      (doc) => {
        this._captureLoadPhases(startedAt);
        this._applyDoc(doc); // bank mismatch throws here and sets fatalError (never retried)
        this._markLoaded();
      },
      (err) => {
        this._captureLoadPhases(startedAt, err);
        const msg = `Could not load vault state from ${this.store.kind}: ${err && err.message ? err.message : err}`;
        this.vaultLoad.failures += 1;
        const delay = Math.min(this.loadRetryMaxMs, this.loadRetryBaseMs * 2 ** Math.min(10, this.vaultLoad.failures - 1));
        this.vaultLoad = {
          ...this.vaultLoad,
          status: 'FAILED',
          lastError: msg,
          lastErrorAt: new Date(now()).toISOString(),
          nextRetryAt: now() + delay
        };
        this.lastError = msg;
        this.lastErrorAt = now();
        if (this.onLoadStateChange) this.onLoadStateChange(this.vaultLoad);
        throw new Error(msg);
      }
    );
    p.catch(() => {});
    return p;
  },

  /** Retry a failed load (called from tick() once the backoff has passed). */
  _retryLoad() {
    let loaded;
    const startedAt = Date.now();
    try {
      loaded = this.store.load();
    } catch (err) {
      loaded = Promise.reject(err);
    }
    this._loadPromise = this._trackLoad(loaded, startedAt);
    return this._loadPromise;
  },

  /** Load status for health: {status LOADING|LOADED|FAILED, attempts, failures, lastError, nextRetryAt}. */
  loadView() {
    const v = this.vaultLoad;
    return {
      ...v,
      nextRetryAt: v.nextRetryAt ? new Date(v.nextRetryAt).toISOString() : null,
      retries: Math.max(0, v.attempts - 1)
    };
  },

  /** Resolves once state is loaded from the store (async for KV stores); rejects while the latest attempt failed. */
  ready() {
    const p = this._loadPromise;
    if (!this.bindOnBoot) return p;
    return p.then(() => {
      if (!this._bootBind) this._bootBind = this._tryBootBind().catch(() => {});
      return this._bootBind;
    });
  },

  async _tryBootBind() {
    if (!this.writer.enabled || !this.writer.supportsLease()) return;
    try {
      if (!(await this.writer.refresh()) && this.writer.status === 'UNBOUND') {
        try {
          await this.bindStore({ via: 'env' });
          await this.writer.refresh();
        } catch (err) {
          this.lastError = `store binding: ${err.message}`;
          this.lastErrorAt = now();
        }
      }
    } finally {
      if (this.passMode && this.writer.status === 'LEADER') {
        await this.writer.release().catch(() => {});
      }
    }
  },

  _applyDoc(doc) {
    this._docLoaded = Boolean(doc && doc.version === 1);
    if (doc && doc.version === 1) {
      this.state = doc;
      if (this.state.createdAt === undefined) this.state.createdAt = 0;
    }
    this.state.inbound = this.state.inbound || {};
    this.state.outbound = this.state.outbound || {};
    this.state.groups = this.state.groups || {};
    this.state.ledgerOut = this.state.ledgerOut || {};
    if (this.state.bankAddress && this.state.bankAddress !== this.bankAddress) {
      this.fatalError = `Settlement store belongs to bank ${this.state.bankAddress}, not ${this.bankAddress}`;
      throw new Error(this.fatalError);
    }
    this.state.bankAddress = this.bankAddress;
    if (doc && doc.engine) {
      if (
        doc.engine.bankAddress &&
        doc.engine.bankAddress !== this.bankAddress &&
        !String(doc.engine.bankAddress).startsWith('poa1BankVault')
      ) {
        this.fatalError = `Stored vault state belongs to bank ${doc.engine.bankAddress}, not ${this.bankAddress}`;
        throw new Error(this.fatalError);
      }
      this.engine.restoreState(doc.engine);
      this.engine.bankAddress = this.bankAddress;
    }
    for (const rec of Object.values(this.state.inbound)) {
      if (rec.status !== 'SUBMITTING') continue;
      rec.status = 'BROADCAST';
      rec.recoveredFrom = 'SUBMITTING';
      if (!Number.isFinite(Number(rec.submittedAt))) rec.submittedAt = now();
    }
    this._rebuildReservations();
    this._rebuildOutboundIndex();
    this._invalidatePlayTime();
    if (this.engine.lockHeal && this.engine.lockHeal !== this._lastLockHeal) {
      this._lastLockHeal = this.engine.lockHeal;
      if (this.logger) {
        this.logger(
          `vault load: locked collateral corrected (stored ${this.engine.lockHeal.storedMicros} micros, now ${this.engine.lockHeal.correctedMicros})`
        );
      }
    }
    this._loaded = true;
    this.engine.externalPersistence = this.store.kind !== 'file';
    this.engine.onStateSaved = () => this._save();
    this._save();
  },

  /**
   * Exposure reservations held in this process = the open bets in the vault document that carry one,
   * plus reservations for submissions still in progress here (not in the document yet).
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
        if (this.engine.processedTxids.has(m[1]) || (r && !OPEN_IN.has(r.status))) continue;
      }
      next.set(key, micros);
    }
    this.engine.batchReservations = next;
    this.engine._syncLocked();
  },

  /** Maintain O(1) lookup from sourceTxid -> outbound orders while tolerating direct state.outbound edits in tests. */
  _rebuildOutboundIndex(keys = null) {
    const map = new Map();
    const outObj = this.state.outbound || {};
    const ks = keys || Object.keys(outObj);
    for (const k of ks) {
      const o = outObj[k];
      if (!o || !o.sourceTxid) continue;
      let list = map.get(o.sourceTxid);
      if (!list) {
        list = [];
        map.set(o.sourceTxid, list);
      }
      list.push(o);
    }
    this._outboundBySource = map;
    this._outboundIndexedRef = outObj;
    this._outboundIndexedLen = ks.length;
  },

  _indexOutbound(rec) {
    if (!rec || !rec.sourceTxid) return;
    const outObj = this.state.outbound || {};
    if (this._outboundIndexedRef !== outObj) {
      this._rebuildOutboundIndex();
      return;
    }
    let list = this._outboundBySource.get(rec.sourceTxid);
    if (!list) {
      list = [];
      this._outboundBySource.set(rec.sourceTxid, list);
    }
    if (!list.some((x) => x.orderId === rec.orderId)) {
      list.push(rec);
      this._outboundIndexedLen = Object.keys(outObj).length;
    }
  },

  _outboundForSource(sourceTxid) {
    const outObj = this.state.outbound || {};
    const keys = Object.keys(outObj);
    if (this._outboundIndexedRef !== outObj || this._outboundIndexedLen !== keys.length) {
      this._rebuildOutboundIndex(keys);
    }
    return (this._outboundBySource.get(sourceTxid) || []).filter((o) => outObj[o.orderId] === o);
  },

  _invalidatePlayTime() {
    this._playTimeCache = null;
  },

  playTimeStats() {
    if (this._playTimeCache) return this._playTimeCache;
    const stats = computePlayTimes(this.state.inbound, this.state.outbound);
    this._playTimeCache = stats;
    return stats;
  },

  /** Queue the vault document for writing. Returns false (and writes nothing) when this instance may not write. */
  _save() {
    if (this._noSave) return false;
    if (!this._loaded) return false;
    if (!this.writer.canWrite()) return false;
    this.state.savedAt = now();
    this._persist.save(() => {
      this.state.engine = this.engine.serializeState();
      return this.state;
    });
    return true;
  },

  async _writeAhead(rec) {
    await this.writer.assertLeader();
    if (!this._save()) {
      throw new Error(`payout ${rec.orderId}: write-ahead not saved (this instance is not the bank writer right now)`);
    }
    await this.flush();
  },

  flush() {
    return this._persist.flush();
  },

  _emit(type, payload) {
    try {
      this.engine._emit(type, payload);
    } catch {
      // ignore
    }
  },

  _confirmed(tx) {
    if (!tx || tx.invalid) return false;
    return this.confirmPolicy === 'included' ? true : tx.final;
  },

  /**
   * Bounded hot-window compaction: strips signed tx bodies on confirmed payouts, folds old finalized
   * bankHistory entries into exact checkpoints, prunes aged terminal inbound/outbound/group records
   * beyond hot limits, and deletes superseded `accepted:<txid>` claims from the store.
   */
  async _compactVault() {
    if (!this.writer.canWrite() || this.reconcile?.status !== 'OK') return false;
    let dirty = false;
    const cutoff = now() - this.compactAgeMs;

    // 1. Strip bulky signed transfer bodies on finalized payouts (retain metadata for audit)
    for (const o of Object.values(this.state.outbound)) {
      if (o.status === 'CONFIRMED' && o.body && !o.repayBlocked && (o.confirmedVia !== 'receipt' || this._listedFinal(o.txid))) {
        delete o.body;
        dirty = true;
      }
    }

    // 2. Fold bankHistory beyond maxBankHistoryRecent into exact checkpoints
    const hist = bankHistoryOf(this.state);
    const folded = compactBankHistory(hist, {
      keepRecent: this.maxBankHistoryRecent,
      guardWindow: Math.max(500, this.addressListCap * 2)
    });
    if (folded > 0) dirty = true;

    // 3. Clean up aged `accepted:<txid>` claims for terminal records older than inboundExpireMs
    const claimCleanupMinAgeMs = Math.max(this.compactAgeMs, Math.min(this.inboundExpireMs, 10 * 60 * 1000));
    for (const rec of Object.values(this.state.inbound)) {
      if (
        rec.acceptedBy === 'standby' &&
        !rec.acceptedClaimCleaned &&
        ['BOOKED', 'EXPIRED', 'FAILED'].includes(rec.status) &&
        now() - Number(rec.bookedAt || rec.submittedAt || 0) >= claimCleanupMinAgeMs
      ) {
        await this._persist.deleteClaim(`accepted:${rec.txid}`).catch(() => {});
        rec.acceptedClaimCleaned = true;
        dirty = true;
      }
    }

    // 4. Prune terminal inbound records beyond maxHotInbound (preserving open, NEEDS_REVIEW, unconfirmed wins, & recent window)
    const inEntries = Object.values(this.state.inbound);
    if (inEntries.length > this.maxHotInbound) {
      const nonConfirmedSources = new Set();
      for (const o of Object.values(this.state.outbound)) {
        if (o.sourceTxid && o.status !== 'CONFIRMED') nonConfirmedSources.add(o.sourceTxid);
      }
      const prunableIn = inEntries
        .filter(
          (r) =>
            ['BOOKED', 'EXPIRED', 'FAILED'].includes(r.status) &&
            !nonConfirmedSources.has(r.txid) &&
            (inEntries.length > this.maxHotInbound * 1.1 || Number(r.bookedAt || r.submittedAt || 0) <= cutoff)
        )
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const excessIn = inEntries.length - this.maxHotInbound;
      const toRemoveIn = prunableIn.slice(0, Math.max(0, excessIn));
      if (toRemoveIn.length > 0) {
        this.state.compacted = this.state.compacted || { inbound: 0, outbound: 0 };
        for (const r of toRemoveIn) {
          if (r.acceptedBy === 'standby' && !r.acceptedClaimCleaned) {
            await this._persist.deleteClaim(`accepted:${r.txid}`).catch(() => {});
          }
          delete this.state.inbound[r.txid];
          this.state.compacted.inbound += 1;
        }
        this._invalidatePlayTime();
        dirty = true;
      }
    }

    // 5. Prune CONFIRMED outbound records beyond maxHotOutbound (marking ledgerOut so compacted payouts are never flagged foreign)
    const outEntries = Object.values(this.state.outbound);
    if (outEntries.length > this.maxHotOutbound) {
      const prunableOut = outEntries
        .filter(
          (o) =>
            o.status === 'CONFIRMED' &&
            !o.repay &&
            !o.repayBlocked &&
            (o.confirmedVia !== 'receipt' || this._listedFinal(o.txid)) &&
            !this.state.inbound[o.sourceTxid] &&
            (outEntries.length > this.maxHotOutbound * 1.1 || Number(o.confirmedAt || 0) <= cutoff)
        )
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const excessOut = outEntries.length - this.maxHotOutbound;
      const toRemoveOut = prunableOut.slice(0, Math.max(0, excessOut));
      if (toRemoveOut.length > 0) {
        this.state.compacted = this.state.compacted || { inbound: 0, outbound: 0 };
        for (const o of toRemoveOut) {
          if (o.txid && this.state.ledgerOut[o.txid]) {
            this.state.ledgerOut[o.txid].knownCompacted = true;
          }
          for (const s of o.superseded || []) {
            if (s.txid && this.state.ledgerOut[s.txid]) this.state.ledgerOut[s.txid].knownCompacted = true;
          }
          delete this.state.outbound[o.orderId];
          this.state.compacted.outbound += 1;
        }
        this._rebuildOutboundIndex();
        this._invalidatePlayTime();
        dirty = true;
      }
    }

    // 6. Prune ledgerOut entries older than maxHotOutbound that are compacted & no longer in minepoa's recent list
    const ledgerOutIds = Object.keys(this.state.ledgerOut || {});
    const maxLedgerOut = this.maxHotOutbound * 2;
    if (ledgerOutIds.length > maxLedgerOut) {
      const recentListed = new Set(this.state.trustedBank?.listedOutIds || []);
      const sortedLo = ledgerOutIds
        .map((id) => [id, this.state.ledgerOut[id]])
        .filter(([id, o]) => o && o.final && o.knownCompacted && !recentListed.has(id))
        .sort((a, b) => Number(a[1].ts || 0) - Number(b[1].ts || 0));
      const dropLo = sortedLo.slice(0, Math.max(0, ledgerOutIds.length - maxLedgerOut));
      for (const [id] of dropLo) {
        delete this.state.ledgerOut[id];
        dirty = true;
      }
    }

    // 7. Prune completed batch groups beyond 200
    const groupIds = Object.keys(this.state.groups || {});
    if (groupIds.length > 200) {
      const doneGroups = groupIds
        .filter((id) => this.state.groups[id]?.completed)
        .sort((a, b) => Number(this.state.groups[a].createdAt || 0) - Number(this.state.groups[b].createdAt || 0));
      for (const id of doneGroups.slice(0, Math.max(0, groupIds.length - 200))) {
        delete this.state.groups[id];
        await this._persist.deleteClaim(`group:${id}`).catch(() => {});
        dirty = true;
      }
    }

    if (dirty) this._save();
    return dirty;
  }
};
