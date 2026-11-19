// @ts-nocheck
/**
 * settlement/leader-coordinator.mjs — Single-writer lease coordination, store binding,
 * standby replication, foreign-outflow attestation, fenced admin mutations, and tick loop.
 */
import crypto from 'node:crypto';
import { BINDING_KEY } from '../bank-writer.mjs';
import { toMicros } from '../crypto-poa.mjs';
import { isLedgerBusy } from '../ledger-probe.mjs';
import {
  LEADER_STATUS_KEY,
  LEADER_WAITING,
  OPEN_IN,
  REPLICA_RELOAD_MS,
  STANDBY_STATUS_REFRESH_MS,
  TERMINAL_OUT,
  now,
  tradingLabel
} from './constants.mjs';

export function docKnownIds(doc) {
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
  for (const id of doc.bankHistory?.recentCompactedIds || []) out.add(id);
  for (const id of Object.keys(doc.inbound || {})) inb.add(id);
  for (const e of eng.processedTxids || []) inb.add(e[0]);
  return { out, in: inb };
}

export const leaderCoordinatorMethods = {
  _sharedFresh(s = this.shared) {
    if (!s) return false;
    const good = Number(s.goodAt ?? s.lastGoodTick ?? 0);
    if (!Number.isFinite(good) || good <= 0) return false;
    return now() - good <= this.leaderStatusMaxAgeMs;
  },

  async _handoverFromFreshStatus(doc) {
    if (!doc) return false;
    const st = await this._readShared();
    if (!st || st.docSavedAt === undefined || st.docSavedAt === null) return false;
    const verified = Number(st.verifiedAt ?? (st.waiting ? 0 : st.at) ?? 0);
    return st.docSavedAt === this._loadedSavedAt && verified > 0 && now() - verified <= this.trustedBalanceMaxAgeMs;
  },

  async passDue() {
    if (now() - this._sharedReadAt > STANDBY_STATUS_REFRESH_MS) await this._readShared();
    const at = Number(this.shared?.at || 0);
    return !at || now() - at > this.passEveryMs;
  },

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
  },

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
  },

  _relayRemoteEvents(events) {
    if (!this.onRemoteEvent || !Array.isArray(events) || !events.length) return;
    if (!this._relayedEventIds) {
      this._relayedEventIds = new Set();
      this._relayedEventOrder = [];
    }
    for (const evt of events) {
      if (!evt || !evt.id || this._relayedEventIds.has(evt.id)) continue;
      this._relayedEventIds.add(evt.id);
      this._relayedEventOrder.push(evt.id);
      if (this._relayedEventOrder.length > 1000) {
        this._relayedEventIds.delete(this._relayedEventOrder.shift());
      }
      try {
        this.onRemoteEvent(evt);
      } catch {
        // ignore listener error
      }
    }
  },

  async _readShared() {
    if (typeof this.store.getStatus !== 'function') return null;
    try {
      this.shared = await this.store.getStatus(LEADER_STATUS_KEY);
      this._sharedReadAt = now();
      if (this.ledgerProbe?.noteRemoteOk && this.shared?.ledger?.lastOkAt) {
        this.ledgerProbe.noteRemoteOk(this.shared.ledger.lastOkAt);
      }
      if (this.shared?.recentEvents) this._relayRemoteEvents(this.shared.recentEvents);
    } catch (err) {
      this._tickErrors.push(`writer status: ${err.message}`);
    }
    return this.shared;
  },

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
      verifiedAt: now(),
      waiting: null,
      trading: tradingLabel(hold),
      hold: hold ? { status: hold.status, reason: hold.reason } : null,
      reconcile: { status: r.status || null, reason: r.reason || null, at: r.at || null, inReview: r.inReview || [], audit: r.audit || null },
      foreignOutflows: this.foreign,
      onChainBankBalancePoa: this._bankBalanceView()?.onChainBankBalancePoa ?? this.lastBankBalance?.balance ?? null,
      coverage: lim.known ? { known: true, limitMicros: lim.limitMicros.toString() } : { known: false, code: lim.code, reason: lim.reason },
      seed: { epoch: this.engine.seedManager.epochId, hash: this.engine.seedManager.currentSeedHash },
      recentEvents: (this.engine.eventHistory || []).slice(-25),
      docSavedAt: this.state.savedAt ?? null,
      lastGoodTick: this.lastGoodTick || null,
      goodAt: this.lastGoodTick || null,
      passMs: this.passes.lastStartedAt ? now() - this.passes.lastStartedAt : null,
      passMode: this.passMode,
      ledger: this.ledgerProbe ? { status: this.ledgerProbe.status, lastError: this.ledgerProbe.lastError || null, lastOkAt: this.ledgerProbe.lastOkAt ?? null } : null,
      lastError: this.lastError || null
    };
  },

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
  },

  async _drainChatClaims() {
    if (typeof this._persist?.listClaims !== 'function') return 0;
    let claims = [];
    try {
      claims = await this._persist.listClaims('chat:');
    } catch {
      return 0;
    }
    if (!claims || !claims.length) return 0;
    const haveIds = new Set(this.engine.chatMessages.map((m) => m && m.id).filter(Boolean));
    const haveSigs = new Set(this.engine.chatMessages.map((m) => m && m.signature).filter(Boolean));
    const sorted = [...claims].sort((a, b) => Number(a.value?.ts || 0) - Number(b.value?.ts || 0));
    let added = 0;
    for (const entry of sorted) {
      const m = entry?.value;
      if (!m || !m.id || !m.text || !m.address || !m.signature) continue;
      if (haveIds.has(m.id) || haveSigs.has(m.signature)) continue;
      const msg = {
        id: m.id,
        ts: Number(m.ts) || Math.floor(now() / 1000),
        address: m.address,
        senderName: m.senderName || `Agent-${String(m.address).slice(4, 10)}`,
        text: m.text,
        isAgent: m.isAgent !== false,
        signature: m.signature,
        verified: Boolean(m.verified)
      };
      this.engine.chatMessages.unshift(msg);
      haveIds.add(msg.id);
      haveSigs.add(msg.signature);
      this.engine._emit('chat.message', msg);
      added += 1;
    }
    if (added > 0) {
      this.engine.chatMessages.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
      if (this.engine.chatMessages.length > 200) this.engine.chatMessages.length = 200;
      if (this.writer.canWrite()) this._save();
    }
    return added;
  },

  async _standbyTick() {
    const s = await this._readShared();
    const due = !this._replicaAt || now() - this._replicaAt > REPLICA_RELOAD_MS;
    if (due || (s && s.docSavedAt !== this._replicaSavedAt)) {
      try {
        const doc = await this._reloadFromStore({ save: false });
        this._replicaSavedAt = doc?.savedAt ?? null;
        this._replicaAt = now();
        for (const [id, rec] of this._standbyLocal) {
          if (this.state.inbound[id] || this.engine.processedTxids.has(id) || now() - rec.submittedAt > this.inboundExpireMs) {
            this._standbyLocal.delete(id);
          } else {
            this.state.inbound[id] = rec;
          }
        }
        this._rebuildReservations();
        if (this.engine.eventHistory?.length) this._relayRemoteEvents(this.engine.eventHistory.slice(-25));
      } catch (err) {
        this._tickErrors.push(`standby reload: ${err.message}`);
      }
    }
    await this._drainChatClaims().catch(() => {});
    if (this._sharedFresh()) this.foreign = this.shared.foreignOutflows || [];
    this.lastTick = now();
    this.lastError = this._tickErrors.length ? this._tickErrors.join('; ') : null;
    if (this.lastError) this.lastErrorAt = now();
  },

  leaderView() {
    const s = this.shared;
    const self = this.writer.canWrite();
    const waitingHere = self && this._waitingOnTakeover();
    const waitingThere = !self && this._sharedWaitingLive();
    const active = self || this._sharedFresh() || waitingThere;
    const w = waitingHere ? this._takeoverWait : waitingThere ? s.waiting : null;
    return {
      active,
      state: waitingHere || waitingThere ? 'WAITING_ON_MINEPOA' : active ? 'ACTIVE' : 'NONE',
      waiting: w
        ? {
            on: 'minepoa',
            since: w.since ? new Date(Number(w.since)).toISOString() : null,
            attempts: w.attempts ?? null,
            retryAt: w.nextAt ?? w.retryAt ? new Date(Number(w.nextAt ?? w.retryAt)).toISOString() : null,
            lastError: w.lastError ?? null
          }
        : null,
      passMode: this.passMode,
      lastPassAt: s?.at ? new Date(Number(s.at)).toISOString() : null,
      lastGoodPassAt: s?.goodAt ? new Date(Number(s.goodAt)).toISOString() : null,
      goodPassAgeMs: s?.goodAt ? Math.max(0, now() - Number(s.goodAt)) : null,
      passRunningHere: Boolean(this._tickPromise),
      thisInstance: self ? (waitingHere ? 'WRITER_WAITING_ON_MINEPOA' : 'WRITER') : this.writer.status,
      statusAt: s?.at ? new Date(Number(s.at)).toISOString() : null,
      statusAgeMs: s?.at ? Math.max(0, now() - Number(s.at)) : null,
      maxAgeMs: this.leaderStatusMaxAgeMs,
      token: s?.token ?? null,
      leaseExpiresAt: s?.leaseExpiresAt ? new Date(Number(s.leaseExpiresAt)).toISOString() : null,
      trading: s?.trading ?? null,
      hold: s?.hold ?? null,
      lastGoodTick: s?.lastGoodTick ? new Date(Number(s.lastGoodTick)).toISOString() : null
    };
  },

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
        const d = await this._claimDecision(f.txid, {
          v: 1,
          kind: 'UNMATCHED_OUTFLOW',
          txid: f.txid,
          to: o.to,
          amountMicros: toMicros(o.amountPoa).toString(),
          memo: String(o.memo || '').slice(0, 200),
          ts: Math.floor(now() / 1000),
          foreign: true
        });
        this._applyDecision(d);
      }
      this.state.foreignAck[f.txid] = { mode: a.mode, at: a.at || new Date(now()).toISOString(), ...(a.note ? { note: a.note } : {}) };
      applied += 1;
    }
    if (applied) this._save();
    return applied;
  },

  async _reloadFromStore({ save = true } = {}) {
    const doc = await this.store.load();
    this._loadedSavedAt = doc?.savedAt ?? null;
    if (doc && doc.version === 1) {
      this.state = {
        version: 1,
        bankAddress: this.bankAddress,
        bankNonce: null,
        inbound: {},
        outbound: {},
        groups: {},
        ledgerOut: {},
        seq: 0,
        createdAt: Math.floor(now() / 1000)
      };
      this._noSave = !save;
      try {
        this._applyDoc(doc);
      } finally {
        this._noSave = false;
      }
    }
    this._seedSyncedEpoch = null;
    return doc && doc.version === 1 ? doc : null;
  },

  async _unaccountedOutflows(doc) {
    this._takeoverMatches = [];
    this._takeoverErr = null;
    let row;
    try {
      row = await this.client.getAddress(this.bankAddress);
    } catch (err) {
      this._takeoverErr = err;
      return undefined;
    }
    const known = docKnownIds(doc).out;
    const attested = new Set(Object.keys(doc?.attestedOutflows || {}));
    const missing = [];
    const matches = [];
    let memos = null;
    for (const t of row.txs || []) {
      if (!t || !t.id || t.from !== this.bankAddress) continue;
      if (known.has(t.id) || attested.has(t.id)) continue;
      if (!Array.isArray(this.writer.binding?.priorLedgerIds)) continue;
      if (this._preBinding(t.id, t.ts)) continue;
      const ex = await this._explainByOrder(doc, t, async () => (memos === null ? (memos = await this._recentMemos()) : memos));
      if (ex === undefined) return undefined;
      if (ex && !matches.some((x) => x.orderId === ex.orderId)) {
        matches.push({ ...ex, txid: t.id, final: Boolean(t.final) });
        continue;
      }
      missing.push(t.id);
    }
    this._takeoverMatches = missing.length ? [] : matches;
    return missing;
  },

  async _recentMemos() {
    const out = new Map();
    try {
      const recent = await this.client.getRecentTransfers(200);
      for (const r of recent.values()) if (typeof r.memo === 'string') out.set(r.id, r.memo);
    } catch {
      // optional
    }
    return out;
  },

  async attestOutflows() {
    const doc = await this.store.load();
    const missing = await this._unaccountedOutflows(doc);
    if (missing === undefined) throw new Error('minepoa did not answer; try again');
    this.writer.unblock();
    this._attestPending = missing;
    await this.tick();
    return { attested: missing, writer: this.writer.view() };
  },

  async _readOnlyTick() {
    await this._readShared();
    const row = await this._scanBank();
    this.foreign = this._foreignOutflows();
    this.lastTick = now();
    this.lastError = this._tickErrors.length ? this._tickErrors.join('; ') : null;
    if (this.lastError) this.lastErrorAt = now();
    return row;
  },

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
    const hist = (row.txs || [])
      .filter((t) => t && t.id && (t.from === this.bankAddress || t.to === this.bankAddress))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const storedDoc = hist.length ? await this.store.load() : null;
    const accepted = new Set(Object.keys(storedDoc?.version === 1 ? storedDoc.inbound || {} : {}));
    const priorLedgerIds = hist
      .map((t) => t.id)
      .filter((id) => !accepted.has(id))
      .slice(0, 5000);
    if (hist.length && !recovery) {
      const doc = storedDoc;
      if (!doc || doc.version !== 1) {
        throw new Error(
          'the store holds no vault state, but the bank has ledger history: refusing to bind (use the admin recovery binding only after a real state loss)'
        );
      }
      if (doc.bankAddress && doc.bankAddress !== this.bankAddress) throw new Error('the stored vault state belongs to a different bank');
      const known = docKnownIds(doc);
      const out = hist.find((t) => t.from === this.bankAddress);
      if (out ? !known.out.has(out.id) : !known.in.has(hist[0].id)) {
        throw new Error(
          `the stored vault state does not know the bank's newest ledger ${out ? 'outflow' : 'transfer'} (${(out || hist[0]).id.slice(0, 16)}): this is not the live store; refusing to bind`
        );
      }
    }
    const binding = {
      bankAddress: this.bankAddress,
      storeId: `store-${crypto.randomBytes(9).toString('hex')}`,
      boundAt: new Date(now()).toISOString(),
      boundAtMs: now(),
      via,
      recovery: Boolean(recovery),
      ledgerTxCount: hist.length,
      priorLedgerIds
    };
    const res = await this.store.claim(BINDING_KEY, binding);
    this.writer.binding = res.value;
    if (this.logger) this.logger(`vault store bound to bank ${this.bankAddress} (${res.value.storeId}, via ${via})`);
    return { alreadyBound: !res.claimed, binding: res.value };
  },

  _foreignOutflows() {
    const known = this._knownOutTxids();
    const tags = this._knownOrderTags();
    const settled = new Set();
    for (const id of this.engine.processedTxids.keys()) settled.add(String(id).slice(0, 16));
    for (const r of Object.values(this.state.inbound)) {
      if (r.status === 'BOOKED' || r.status === 'NEEDS_REVIEW') settled.add(r.txid.slice(0, 16));
    }
    const acks = this.state.foreignAck || {};
    const out = [];
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) {
      if (!o.final || known.has(id) || this.engine.recoveredOutflows.has(id)) continue;
      if (o.ord && tags.has(o.ord) && this._ordFits(id, o)) continue;
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
        reason:
          o.ord && tags.has(o.ord)
            ? `tagged for order ${o.ord} of this vault but does not match it (recipient, amount or signed body); the order is not paid again`
            : ref
              ? 'pays a bet/transaction this vault already settled'
              : 'signed with the bank key after the store binding, not by this vault',
        acknowledged: acks[id] || null,
        explorer: this.client.explorerTxUrl(id)
      });
    }
    return out;
  },

  async ackForeignOutflows({ txids = [], mode, note = null }) {
    if (!['book_loss', 'reimbursed'].includes(mode)) throw new Error("mode must be 'book_loss' or 'reimbursed'");
    if (!Array.isArray(txids) || !txids.length) throw new Error('txids: list the foreign outflow txids to acknowledge');
    await this.tick();
    const writer = this.writer.canWrite();
    if (!writer) {
      if (this.writer.status !== 'STANDBY') {
        throw Object.assign(new Error(this._writerRefusal().reason), { status: 503, code: 'SIGNER_READ_ONLY', retryable: true });
      }
      await this._readShared();
      if (!this._sharedFresh()) throw new Error(this._standbyHold().reason);
    }
    const list = writer ? this._foreignOutflows() : this.shared.foreignOutflows || [];
    const foreign = new Map(list.map((f) => [f.txid, f]));
    for (const id of txids) if (!foreign.has(id)) throw new Error(`${String(id).slice(0, 16)} is not a listed foreign outflow`);
    const done = [];
    for (const id of txids) {
      const res = await this.store.claim(`foreign-ack:${id}`, {
        txid: id,
        mode,
        at: new Date(now()).toISOString(),
        ...(note ? { note: String(note).slice(0, 200) } : {})
      });
      done.push({ txid: id, mode: res.value.mode, ...(res.claimed ? {} : { alreadyAcknowledged: true }) });
    }
    if (!writer) {
      if (this.passMode) {
        const r = await this.maybePass({ force: true, budgetMs: 8000 }).catch(() => ({ finished: false }));
        await this._observe().catch(() => {});
        if (r.finished && this._sharedFresh()) {
          return { acknowledged: done, appliedBy: 'settlement pass', foreign: this.shared.foreignOutflows || [] };
        }
      }
      return { acknowledged: done, appliedBy: 'the bank writer on its next pass', foreign: list };
    }
    await this._applyForeignAcks();
    await this.flush();
    await this.tick();
    return { acknowledged: done, foreign: this._foreignOutflows() };
  },

  /**
   * Execute an administrative state mutation (`/api/seed/rotate`, `/api/dev/sweep`, `/api/epoch/advance`,
   * `bank_incentives_info(compound_now)`) strictly under the single-writer lease with durable flush BEFORE
   * returning or revealing secrets.
   */
  async runAdminMutation(fn, { forbidOpenServerBets = false } = {}) {
    while (this._tickPromise) await this._tickPromise.catch(() => {});
    if (this._observePromise) await this._observePromise.catch(() => {});
    if (this.fatalError) {
      throw Object.assign(new Error(this.fatalError), { status: 503, code: 'SETTLEMENT_STORE_MISMATCH' });
    }
    if (!this._loaded) {
      await this.tick().catch(() => {});
      if (!this._loaded) {
        throw Object.assign(new Error(this.tradingHold()?.reason || 'Vault state is not loaded yet'), {
          status: 503,
          code: 'SIGNER_READ_ONLY'
        });
      }
    }
    await this.ready();

    let leader = await this.writer.refresh();
    if (!leader && this.writer.status === 'UNBOUND' && this.bindOnBoot) {
      await this.bindStore({ via: 'env' }).catch(() => {});
      leader = await this.writer.refresh();
    }
    if (!leader && this.passMode && this.writer.status === 'STANDBY') {
      const deadline = now() + 3000;
      while (!leader && now() < deadline && this.writer.status === 'STANDBY') {
        await new Promise((r) => setTimeout(r, 150));
        leader = await this.writer.refresh();
      }
    }
    if (!leader) {
      const refusal = this._writerRefusal();
      throw Object.assign(
        new Error(`Cannot execute admin mutation: instance does not hold bank writer lease (${this.writer.status}: ${refusal.reason})`),
        { status: 503, code: 'SIGNER_READ_ONLY', retryable: this.writer.status === 'STANDBY' }
      );
    }

    this.writer.touch();
    this.writer.startHeartbeat();
    let succeeded = false;
    try {
      if (this._leaderToken !== this.writer.lease.token) {
        const doc = await this._reloadFromStore({ save: false });
        const continuing = Boolean(
          this._lastPass &&
            doc &&
            this._lastPass.holder === this.writer.holderId &&
            this.writer.lease.token === this._lastPass.token + 1 &&
            this._loadedSavedAt === this._lastPass.savedAt
        );
        if (!continuing) {
          let missing = await this._unaccountedOutflows(doc);
          if (missing === undefined && (await this._handoverFromFreshStatus(doc))) {
            missing = [];
          }
          if (missing === undefined) {
            throw Object.assign(new Error('Writer handover check pending: minepoa explorer is busy; retry shortly.'), {
              status: 503,
              code: 'RECONCILING',
              retryable: true
            });
          }
          if (missing.length) {
            const msg = `stored vault does not account for bank transfer(s) ${missing.map((id) => id.slice(0, 16)).join(', ')}`;
            await this.writer.block(msg, missing);
            throw Object.assign(new Error(msg), { status: 503, code: 'STALE_STORE' });
          }
          for (const mt of this._takeoverMatches || []) {
            const rec = this.state.outbound[mt.orderId];
            if (rec && rec.txid !== mt.txid && !TERMINAL_OUT.has(rec.status)) {
              this._applyOrderMatch(rec, mt.txid, { via: `takeover:${mt.via}`, claim: mt.claim, final: mt.final });
            }
          }
          this._takeoverMatches = [];
        }
        this._leaderToken = this.writer.lease.token;
        this._standbyLocal.clear();
      }

      this.writer.tokenAtTickStart = this.writer.lease.token;
      await this._drainStandbyAcceptedClaims();

      if (forbidOpenServerBets) {
        const openBets = Object.values(this.state.inbound).filter(
          (r) => OPEN_IN.has(r.status) && r.action === 'BET' && r.discoveredBy !== 'ledger-scan'
        );
        if (openBets.length > 0) {
          throw Object.assign(
            new Error(
              `Cannot rotate server seed while ${openBets.length} server-accepted bet(s) are open on chain; wait for settlement or pass {"force": true}.`
            ),
            { status: 409, code: 'IN_FLIGHT_BETS_OPEN', openBets: openBets.length }
          );
        }
      }

      await this.writer.assertLeader();
      const prevNoSave = this._noSave;
      this._noSave = true;
      let out;
      try {
        out = await fn();
      } finally {
        this._noSave = prevNoSave;
      }

      if (!(await this._syncSeed())) {
        throw Object.assign(new Error('Vault store unavailable (seed claim failed)'), { status: 503, code: 'SETTLEMENT_STORE_ERROR' });
      }
      this._adoptOutbound();
      await this.writer.assertLeader();
      if (!this._save()) {
        throw Object.assign(new Error('Admin write refused: writer lease lost before save'), { status: 503, code: 'SIGNER_READ_ONLY' });
      }
      await this.flush();
      await this._publishStatus();
      succeeded = true;
      return out;
    } finally {
      this.writer.tokenAtTickStart = null;
      if (this.passMode && this.writer.status === 'LEADER') {
        if (succeeded && this.writer.canWrite()) {
          this._lastPass = {
            holder: this.writer.holderId,
            token: this.writer.lease.token,
            savedAt: this.state.savedAt ?? null,
            at: now()
          };
        } else {
          this._lastPass = null;
        }
        await this.writer.release().catch(() => {});
      }
      if (!this._waitingOnTakeover()) this.writer.stopHeartbeat();
    }
  },

  tick() {
    if (this._tickPromise) return this._tickPromise;
    this._tickPromise = (async () => {
      await null;
      if (this._observePromise) await this._observePromise.catch(() => {});
      this._tickErrors = [];
      let passStarted = false;
      try {
        if (this.fatalError) return;
        if (!this._loaded) {
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
          this._takeoverWait = null;
          this._waitBase = null;
          if (this.writer.status === 'STANDBY') await this._standbyTick();
          else await this._readOnlyTick();
          return;
        }
        this.writer.touch();
        this.writer.startHeartbeat();
        passStarted = true;
        this.passes.started += 1;
        this.passes.lastStartedAt = now();
        if (this._leaderToken !== this.writer.lease.token) {
          const doc = await this._reloadFromStore({ save: false });
          const continuing = Boolean(
            this._lastPass &&
              doc &&
              this._lastPass.holder === this.writer.holderId &&
              this.writer.lease.token === this._lastPass.token + 1 &&
              this._loadedSavedAt === this._lastPass.savedAt
          );
          if (!continuing) {
            await this._readShared();
            const sh = this.shared;
            if (sh && (sh.holder !== this.writer.holderId || !sh.waiting)) this._waitBase = sh;
            this._adoptSharedWait();
            if (this._takeoverWait && now() < this._takeoverWait.nextAt) {
              await this._finishWaitingTick();
              return;
            }
          }
          let missing = continuing ? [] : await this._unaccountedOutflows(doc);
          if (missing === undefined && (await this._handoverFromFreshStatus(doc))) {
            missing = [];
            this._tickErrors.push('writer takeover: explorer busy; continued from the last published document');
          }
          const attest = new Set(this._attestPending || []);
          this._attestPending = null;
          const unexplained = (missing || []).filter((id) => !attest.has(id));
          if (missing === undefined || unexplained.length) {
            if (missing === undefined) {
              this._noteTakeoverBusy(this._takeoverErr);
              await this._finishWaitingTick();
              return;
            } else {
              const msg = `stored vault does not account for bank transfer(s) ${unexplained.map((id) => id.slice(0, 16)).join(', ')}: refusing to sign (old copy of the store, or a transfer made outside this vault)`;
              this._tickErrors.push(`writer takeover: ${msg}`);
              await this.writer.block(msg, unexplained);
            }
            await this._readOnlyTick();
            return;
          }
          for (const mt of this._takeoverMatches || []) {
            const rec = this.state.outbound[mt.orderId];
            if (rec && rec.txid !== mt.txid && !TERMINAL_OUT.has(rec.status)) {
              this._applyOrderMatch(rec, mt.txid, { via: `takeover:${mt.via}`, claim: mt.claim, final: mt.final });
            }
          }
          this._takeoverMatches = [];
          this._takeoverWait = null;
          this._waitBase = null;
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
        await this._drainStandbyAcceptedClaims();
        await this._drainChatClaims();
        const row = await this._scanBank();
        await this._confirmInbound();
        await this._matchLedgerPayouts().catch((err) => this._tickErrors.push(`ord match: ${err.message}`));
        await this._applyForeignAcks().catch((err) => this._tickErrors.push(`foreign acks: ${err.message}`));
        await this._applyRepays().catch((err) => this._tickErrors.push(`repay: ${err.message}`));
        await this._reconcile(row);
        this._adoptOutbound();
        await this._processOutbound(row);
        await this._compactVault().catch((err) => this._tickErrors.push(`compact: ${err.message}`));
        await this.flush();
        this.lastTick = now();
        if (this._tickErrors.length) {
          this.lastError = this._tickErrors.join('; ');
          this.lastErrorAt = now();
        } else {
          this.lastError = null;
        }
        const hardErrors = this._tickErrors.filter((e) => !isLedgerBusy(e));
        this.lastGoodTick = hardErrors.length ? this.lastGoodTick : now();
        await this._publishStatus();
        this.writer.tokenAtTickStart = null;
        this.passes.completed += 1;
        this.passes.lastCompletedAt = now();
        this.passes.lastMs = now() - this.passes.lastStartedAt;
        if (this.passMode && this.writer.canWrite()) {
          this._lastPass = {
            holder: this.writer.holderId,
            token: this.writer.lease.token,
            savedAt: this.state.savedAt ?? null,
            at: now()
          };
          await this.writer.release();
        }
      } catch (err) {
        this.lastError = String(err.message || err);
        this.lastErrorAt = now();
        if (this.logger) this.logger(`settlement tick error: ${this.lastError}`);
        if (this.passMode && passStarted && this.writer.status === 'LEADER') {
          this._lastPass = null;
          await this.writer.release().catch(() => {});
        }
      } finally {
        if (!this._waitingOnTakeover()) this.writer.stopHeartbeat();
        this._tickPromise = null;
      }
    })();
    return this._tickPromise;
  },

  _takeoverPending() {
    return this.writer.status === 'LEADER' && Boolean(this.writer.lease?.held) && this._leaderToken !== this.writer.lease.token;
  },

  _waitingOnTakeover() {
    return Boolean(this._takeoverWait) && this._takeoverPending();
  },

  _takeoverDelay(attempts, retryAfterMs = 0) {
    const ra = Math.max(0, Number(retryAfterMs) || 0);
    const exp = Math.min(this.takeoverBackoffMaxMs, this.takeoverBackoffBaseMs * 2 ** Math.max(0, attempts - 1));
    const jittered = exp * (0.5 + 0.5 * this._random());
    const floor = ra > 0 ? ra * (1 + 0.2 * this._random()) : 0;
    return Math.round(Math.max(jittered, floor));
  },

  _noteTakeoverBusy(err) {
    const t = now();
    const retryAfterMs = Math.max(Number(err?.retryAfterMs) || 0, this.client?.busy?.('read')?.retryAfterMs || 0);
    const prev = this._takeoverWait;
    const attempts = (prev?.attempts || 0) + 1;
    const delay = this._takeoverDelay(attempts, retryAfterMs);
    const msg = err ? String(err.message || err).slice(0, 200) : 'no answer';
    this._takeoverWait = { since: prev?.since || t, attempts, triedAt: t, nextAt: t + delay, retryAfterMs, lastError: msg };
    this._tickErrors.push(`writer takeover: minepoa did not answer (${msg}); keeping the lease, retry in ${Math.ceil(delay / 1000)} s`);
  },

  _adoptSharedWait() {
    const w = this.shared?.waiting;
    if (!w || (this.shared.holder === this.writer.holderId && this._takeoverWait)) return;
    const t = now();
    const retryAt = Math.min(Number(w.retryAt) || 0, t + Math.max(this.takeoverBackoffMaxMs, this.client?.busyMaxMs || 0) * 1.2);
    if (retryAt <= t) return;
    const own = this._takeoverWait;
    if (own && own.nextAt >= retryAt) return;
    this._takeoverWait = {
      since: Math.min(own?.since || t, Number(w.since) || t),
      attempts: Math.max(own?.attempts || 0, Number(w.attempts) || 0),
      nextAt: retryAt,
      retryAfterMs: own?.retryAfterMs || 0,
      lastError: own?.lastError || (w.lastError ? String(w.lastError).slice(0, 200) : null),
      adopted: true
    };
  },

  _waitingReason() {
    const w = this._takeoverWait || this.shared?.waiting || {};
    const since = w.since ? new Date(Number(w.since)).toISOString() : 'just now';
    const next = Number(w.nextAt ?? w.retryAt ?? 0);
    const left = next > now() ? `next try in ${Math.ceil((next - now()) / 1000)} s` : 'retrying now';
    return `The bank writer is active and waiting on minepoa (since ${since}; ${left}) to confirm the bank's ledger before its first settlement pass. Bets and withdrawals are held until that pass completes; nothing is lost.`;
  },

  _waitingHold() {
    return { status: 'RECONCILING', reason: this._waitingReason(), writer: LEADER_WAITING };
  },

  _waitingStatusDoc() {
    const base = this._waitBase || {};
    const w = this._takeoverWait || {};
    const hold = this._waitingHold();
    return {
      v: 1,
      holder: this.writer.holderId,
      token: this.writer.lease?.token ?? null,
      leaseExpiresAt: Number(this.writer.lease?.expiresAt || 0),
      at: now(),
      verifiedAt: base.verifiedAt ?? (base.waiting ? null : base.at ?? null),
      goodAt: base.goodAt ?? null,
      lastGoodTick: base.lastGoodTick ?? null,
      docSavedAt: base.docSavedAt ?? null,
      seed: base.seed ?? null,
      foreignOutflows: base.foreignOutflows || [],
      onChainBankBalancePoa: base.onChainBankBalancePoa ?? null,
      reconcile: base.reconcile ?? null,
      trading: tradingLabel(hold),
      hold: { status: hold.status, reason: hold.reason },
      coverage: { known: false, code: LEADER_WAITING, reason: hold.reason },
      waiting: { on: 'minepoa', phase: 'takeover', since: w.since ?? now(), attempts: w.attempts ?? 0, retryAt: w.nextAt ?? null, lastError: w.lastError ?? null },
      passMode: this.passMode,
      ledger: this.ledgerProbe
        ? { status: this.ledgerProbe.status, lastError: this.ledgerProbe.lastError || null, lastOkAt: this.ledgerProbe.lastOkAt ?? null }
        : (base.ledger ?? null),
      lastError: this.lastError || null
    };
  },

  async _publishWaiting() {
    if (typeof this.store.putStatus !== 'function' || !this.writer.canWrite() || !this._waitingOnTakeover()) return;
    if (!this._waitBase) {
      this._waitBase = this.shared && !(this.shared.waiting && this.shared.holder === this.writer.holderId) ? this.shared : {};
    }
    try {
      const doc = this._waitingStatusDoc();
      await this.store.putStatus(LEADER_STATUS_KEY, doc);
      this.shared = doc;
      this._sharedReadAt = now();
    } catch (err) {
      this._tickErrors.push(`writer status publish: ${err.message}`);
    }
  },

  async _finishWaitingTick() {
    await this._publishWaiting();
    this.lastTick = now();
    if (this._takeoverWait?.lastError && !this._tickErrors.some((e) => e.startsWith('writer takeover'))) {
      this._tickErrors.push(`writer takeover: waiting on minepoa (${this._takeoverWait.lastError})`);
    }
    this.lastError = this._tickErrors.length ? this._tickErrors.join('; ') : null;
    if (this.lastError) this.lastErrorAt = now();
  },

  _onWriterBeat() {
    if (!this._waitingOnTakeover()) return;
    if (!this._tickPromise) this.writer.touch();
    if (this._tickPromise) {
      this._publishWaiting().catch(() => {});
      return;
    }
    if (now() >= this._takeoverWait.nextAt) this.tick();
    else this._publishWaiting().catch(() => {});
  },

  _sharedWaitingLive(s = this.shared) {
    if (!s || !s.waiting) return false;
    const t = now();
    const at = Number(s.at || 0);
    const freshFor = Math.min(this.leaderStatusMaxAgeMs, Math.max(2 * (this.writer.leaseMs || 30000), 3000));
    return Number(s.leaseExpiresAt || 0) > t && t - at <= freshFor;
  },

  kick(delayMs = 50) {
    if (this._kickTimer) return;
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      this.tick();
    }, delayMs);
    if (this._kickTimer.unref) this._kickTimer.unref();
  },

  start(intervalMs = 5000) {
    this.stop();
    this._timer = setInterval(() => this.tick(), intervalMs);
    if (this._timer.unref) this._timer.unref();
    this.tick();
  },

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._kickTimer) clearTimeout(this._kickTimer);
    this._kickTimer = null;
  },

  async idle() {
    while (this._tickPromise) await this._tickPromise;
  },

  getTxStatus(id) {
    if (this.state.inbound[id]) return this._inboundView(this.state.inbound[id]);
    if (this.state.outbound[id]) return this._outboundView(this.state.outbound[id]);
    const out = Object.values(this.state.outbound).find(
      (o) => o.txid === id || (o.superseded || []).some((s) => s.txid === id)
    );
    if (out) return this._outboundView(out);
    if (this.engine.processedTxids.has(id)) {
      return { txid: id, status: 'CONFIRMED', rawStatus: 'BOOKED', result: this.engine.processedTxids.get(id) };
    }
    return null;
  }
};
