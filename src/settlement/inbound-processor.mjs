// @ts-nocheck
/**
 * settlement/inbound-processor.mjs — Inbound validation, spendability pre-check, standby claim
 * adoption, ledger confirmation, ticket claiming, and deterministic roll booking.
 */
import { buildSignedTransfer, fromMicros, isValidPoaAddress, parseDiceMemo, toMicros, txidOf, verifyBody } from '../crypto-poa.mjs';
import { isLedgerBusy, LEDGER_HOLD } from '../ledger-probe.mjs';
import {
  HOLD_ACTIONS,
  NO_ACTIVE_LEADER,
  OPEN_IN,
  STANDBY_STATUS_REFRESH_MS,
  bad,
  now
} from './constants.mjs';

export const inboundProcessorMethods = {
  async buildSignedFor(wallet, { amount, memo }) {
    const cached = this._nonceCache.get(wallet.address);
    let nonce;
    if (cached && now() - cached.at < 60000) nonce = cached.next;
    else nonce = await this.client.nextNonce(wallet.address);
    const parents = await this._parents();
    const tx = buildSignedTransfer({ wallet, to: this.bankAddress, amount, memo, nonce, parents, cid: this.client.chainId });
    this._nonceCache.set(wallet.address, { next: nonce + 1, at: now() });
    return tx;
  },

  async _parents() {
    if (this._tip && now() - this._tip.at < 5000) return this._tip.ids;
    const ids = await this.client.getTipParents();
    this._tip = { ids, at: now() };
    return ids;
  },

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
  },

  /**
   * Reject 0-POA / unfunded spam keypairs BEFORE reserving `poa_dice_reservations` house coverage or writing
   * to the vault. Uses minepoa's non-broadcast `POST /api/submit?dry=1` preflight (which knows vested mining
   * rewards as well as transfer balances) and falls through cleanly when the node is busy or unreachable.
   */
  async _assertSenderCanCoverBet(body) {
    if (typeof this.client?.dryCheckTx !== 'function') return;
    const dry = await this.client.dryCheckTx(body).catch(() => ({ ok: true, unknown: true }));
    if (!dry || dry.ok || dry.unknown) return;
    if (dry.status === 400 || dry.status === 422) {
      const errText = String(dry.error || '');
      if (/insufficient balance|not enough|unvested/i.test(errText)) {
        throw Object.assign(
          new Error(
            `On-chain insufficient balance (${errText}) for ${body.amount} POA bet; nothing was reserved or broadcast.`
          ),
          { status: 400, code: 'INSUFFICIENT_FUNDS' }
        );
      }
      if (/bad nonce.*expected 1\b/i.test(errText)) {
        throw Object.assign(
          new Error(`Invalid fresh-account nonce (${errText}); nothing was reserved or broadcast.`),
          { status: 400, code: 'INVALID_NONCE' }
        );
      }
    }
  },

  /**
   * Writer pass: directly adopt any `accepted:<txid>` claims written by standby instances so even a
   * 1,000-roll batch that scrolls past minepoa's 100-tx address window is tracked and settled in full.
   */
  async _drainStandbyAcceptedClaims() {
    if (!this.writer.canWrite()) return 0;
    let claims = [];
    try {
      claims = await this._persist.listClaims('accepted:');
    } catch (err) {
      this._tickErrors.push(`standby claims: ${err.message}`);
      return 0;
    }
    let adopted = 0;
    const sorted = [...claims].sort((a, b) => Number(a.value?.submittedAt || 0) - Number(b.value?.submittedAt || 0));
    for (const entry of sorted) {
      const a = entry?.value;
      if (!a || !a.txid || this.state.inbound[a.txid] || this.engine.processedTxids.has(a.txid)) continue;
      let groupId = null;
      if (a.groupId) {
        if (!this.state.groups[a.groupId] && typeof this.store.peek === 'function') {
          const g = await Promise.resolve(this.store.peek(`group:${a.groupId}`)).catch(() => null);
          if (g) {
            this.state.groups[a.groupId] = {
              count: g.count,
              address: g.address,
              resolved: 0,
              done: 0,
              wins: 0,
              losses: 0,
              netMicros: '0',
              completed: false,
              createdAt: g.createdAt || now()
            };
          }
        }
        if (this.state.groups[a.groupId]) groupId = a.groupId;
      }
      const action = a.action || parseDiceMemo(a.memo || '').action || null;
      this.state.inbound[a.txid] = {
        txid: a.txid,
        seq: ++this.state.seq,
        from: a.from,
        amountPoa: a.amountPoa,
        memo: a.memo,
        action,
        seedCommit:
          action === 'BET' && a.seedCommit?.hash
            ? { epoch: a.seedCommit.epoch, hash: a.seedCommit.hash, at: a.seedCommit.at }
            : null,
        status: 'BROADCAST',
        submittedAt: Number(a.submittedAt) || now(),
        acceptedBy: 'standby',
        reserve: null,
        coverage: a.coverage?.key && a.coverage?.micros ? { key: String(a.coverage.key), micros: String(a.coverage.micros) } : null,
        groupId,
        attempts: 1,
        error: null,
        result: null,
        ledger: null
      };
      adopted += 1;
    }
    if (adopted > 0) this._save();
    return adopted;
  },

  async submitInbound(txEnvelope, { reserve = null, groupId = null, coverage = null } = {}) {
    if (!this._loaded) await this.tick().catch(() => {});
    if (!this._loaded) {
      throw Object.assign(new Error(`${this.tradingHold().reason} Not broadcast; nothing was booked.`), {
        status: 503,
        code: 'SIGNER_READ_ONLY'
      });
    }
    await this.ready();
    const { body, txid, parsed } = this._validateInbound(txEnvelope);
    if (!this.writer.canWrite()) {
      const known = Boolean(this.state.inbound[txid]) || this.engine.processedTxids.has(txid);
      if (this.passMode && this.writer.status === 'STANDBY') await this._observe(STANDBY_STATUS_REFRESH_MS).catch(() => {});
      else if (!known || this.writer.status === 'STANDBY') await this.tick().catch(() => {});
      if (!this.writer.canWrite()) {
        if (this.writer.status === 'STANDBY') return this._submitAsStandby({ body, txid, parsed, reserve, groupId, coverage });
        if (!known) {
          const h = this._writerRefusal();
          throw Object.assign(new Error(`${h.reason} Not broadcast; nothing was booked.`), {
            status: 503,
            code: 'SIGNER_READ_ONLY',
            retryable: true,
            txid
          });
        }
      }
    }
    if (this._waitingOnTakeover() && !this.state.inbound[txid] && !this.engine.processedTxids.has(txid)) {
      await this.tick().catch(() => {});
      if (this._waitingOnTakeover()) {
        const h = this._waitingHold();
        throw Object.assign(new Error(`${h.reason} Not broadcast; nothing was booked.`), {
          status: 503,
          code: h.status,
          retryable: true,
          txid
        });
      }
    }
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
    if (existing && existing.status !== 'FAILED' && existing.status !== 'EXPIRED') {
      return this._inboundView(existing, { duplicate: true });
    }
    if (this.engine.processedTxids.has(txid)) {
      return { txid, status: 'BOOKED', duplicate: true, result: this.engine.processedTxids.get(txid) };
    }

    if (parsed.action === 'BET' && !coverage) {
      await this._assertSenderCanCoverBet(body);
    }

    let cov = coverage;
    if (parsed.action === 'BET' && !cov) {
      const q = this.engine.quoteBet({
        address: body.from,
        amountPoa: body.amount,
        targetBps: parsed.targetBps,
        direction: parsed.direction
      });
      if (!q.payoutOnWinMicros) {
        throw Object.assign(new Error(q.error || 'Bet outside allowed limits'), { status: 400, code: 'BET_LIMITS', quote: q });
      }
      await this.reserveBetCoverage(txid, BigInt(q.payoutOnWinMicros));
      cov = { key: txid, micros: String(q.payoutOnWinMicros) };
    }
    if (parsed.action === 'BET' && !(await this._syncSeed())) {
      if (cov) this.releaseBetCoverage(cov.key, cov.key === txid ? null : cov.micros);
      throw Object.assign(new Error('Vault store unavailable (seed commitment); not broadcast'), {
        status: 503,
        txid,
        coverageReleased: Boolean(cov)
      });
    }
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
      const released = this._releaseCoverage(rec);
      await this._forgetUnsent(txid);
      throw Object.assign(new Error(`Vault store unavailable; not broadcast: ${err.message}`), {
        status: 503,
        txid,
        coverageReleased: released
      });
    }

    try {
      rec.attempts += 1;
      const resp = await this.client.submitTx(body);
      if (resp && Number.isInteger(Number(resp.next_nonce))) {
        this._nonceCache.set(body.from, { next: Number(resp.next_nonce), at: now() });
      }
      rec.status = 'BROADCAST';
    } catch (err) {
      this.ledgerProbe?.reportFailure('player broadcast', err);
      const seen = await this.client.getTx(txid).catch(() => undefined);
      if (seen || (seen === undefined && !err.definitive)) {
        rec.status = 'BROADCAST';
      } else {
        const errMsg = String(err.message || err);
        this._nonceCache.delete(body.from);
        this._releaseReserve(rec);
        const released = this._releaseCoverage(rec);
        this._resolveGroup(rec);
        delete this.state.inbound[txid];
        await this._forgetUnsent(txid);
        this._emit('settlement.updated', {
          direction: 'inbound',
          txid,
          status: 'FAILED',
          rawStatus: 'FAILED',
          action: rec.action,
          from: rec.from,
          amountPoa: rec.amountPoa,
          explorer: this.client.explorerTxUrl(txid),
          result: null,
          error: errMsg,
          payouts: []
        });
        throw Object.assign(new Error(`Broadcast to minepoa failed; nothing was booked: ${errMsg}`), {
          status: 502,
          txid,
          coverageReleased: released
        });
      }
    }
    this._save();
    this._emit('settlement.updated', this._inboundView(rec));
    this.kick();
    return this._inboundView(rec);
  },

  async _forgetUnsent(txid) {
    let saved = false;
    try {
      saved = this._save();
      if (saved) await this.flush();
    } catch (err) {
      if (this.logger) this.logger(`refused submit ${String(txid).slice(0, 16)}: re-save without it failed: ${err.message}`);
    }
    if (!saved) this._persist.dropPending?.();
  },

  _releaseReserve(rec) {
    if (!rec.reserve) return;
    this.engine.releaseExposure(rec.reserve.key, BigInt(rec.reserve.micros));
    rec.reserve = null;
  },

  _resolveGroup(rec) {
    if (!rec.groupId || rec.groupResolved) return;
    rec.groupResolved = true;
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
        netPoa:
          (BigInt(g.netMicros) < 0n ? '-' : '') +
          fromMicros(BigInt(g.netMicros) < 0n ? -BigInt(g.netMicros) : BigInt(g.netMicros)),
        stoppedReason: g.done === g.count ? 'completed_all_rolls' : 'some_rolls_not_settled',
        settlement: 'chain'
      });
    } else if (r && r.action === 'BET_SETTLED') {
      this._emit('batch.progress', {
        batchId: rec.groupId,
        address: g.address,
        count: g.count,
        done: g.done,
        wins: g.wins,
        losses: g.losses
      });
    }
  },

  openGroup(groupId, { count, address }) {
    this.state.groups[groupId] = {
      count,
      address,
      resolved: 0,
      done: 0,
      wins: 0,
      losses: 0,
      netMicros: '0',
      completed: false,
      createdAt: now()
    };
    if (!this.writer.canWrite() && this.writer.status === 'STANDBY') {
      const p = Promise.resolve(this.store.claim(`group:${groupId}`, { count, address, createdAt: now() }));
      p.catch(() => {});
      this._groupClaims.set(groupId, p);
      return;
    }
    this._save();
  },

  async _submitAsStandby({ body, txid, parsed, reserve, groupId, coverage }) {
    const refuse = (msg, status, code, extra = {}) => Object.assign(new Error(msg), { status, code, txid, ...extra });
    const existing = this.state.inbound[txid];
    if (existing && existing.status !== 'FAILED' && existing.status !== 'EXPIRED') {
      return this._inboundView(existing, { duplicate: true });
    }
    if (this.engine.processedTxids.has(txid)) {
      return { txid, status: 'BOOKED', duplicate: true, result: this.engine.processedTxids.get(txid) };
    }
    if (now() - this._sharedReadAt > STANDBY_STATUS_REFRESH_MS) await this._readShared();
    if (!this._sharedFresh()) {
      const h = this._standbyHold();
      throw refuse(`${h.reason} Not broadcast; nothing was booked.`, 503, h?.status || NO_ACTIVE_LEADER);
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
      if (seen) {
        return {
          direction: 'inbound',
          txid,
          status: 'PENDING_CONFIRMATION',
          rawStatus: 'BROADCAST',
          action: parsed.action,
          from: body.from,
          amountPoa: body.amount,
          explorer: this.client.explorerTxUrl(txid),
          duplicate: true
        };
      }
      throw refuse(
        'This signed transaction was already submitted once and is not on the ledger; it is not broadcast again. Sign a new one.',
        409,
        'ALREADY_SUBMITTED'
      );
    }
    const seed = this.shared.seed;
    if (parsed.action === 'BET' && (!seed || !seed.hash)) {
      throw refuse('The bank writer has not published its seed commitment yet; not broadcast.', 503, NO_ACTIVE_LEADER);
    }
    if (parsed.action === 'BET' && !coverage) {
      await this._assertSenderCanCoverBet(body);
    }
    let cov = coverage;
    if (parsed.action === 'BET' && !cov) {
      const q = this.engine.quoteBet({
        address: body.from,
        amountPoa: body.amount,
        targetBps: parsed.targetBps,
        direction: parsed.direction
      });
      if (!q.payoutOnWinMicros) {
        throw Object.assign(new Error(q.error || 'Bet outside allowed limits'), { status: 400, code: 'BET_LIMITS', quote: q });
      }
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
      const released = cov && !String(err.message).includes('concurrently') ? this._releaseCoverage(rec) : false;
      throw refuse(`Vault store unavailable; not broadcast: ${err.message}`, 503, 'SETTLEMENT_STORE_ERROR', {
        coverageReleased: released
      });
    }
    this.state.inbound[txid] = rec;
    this._standbyLocal.set(txid, rec);
    try {
      rec.attempts += 1;
      const resp = await this.client.submitTx(body);
      if (resp && Number.isInteger(Number(resp.next_nonce))) {
        this._nonceCache.set(body.from, { next: Number(resp.next_nonce), at: now() });
      }
      rec.status = 'BROADCAST';
    } catch (err) {
      this.ledgerProbe?.reportFailure('player broadcast', err);
      const seen = await this.client.getTx(txid).catch(() => undefined);
      if (seen || (seen === undefined && !err.definitive)) {
        rec.status = 'BROADCAST';
      } else {
        const errMsg = String(err.message || err);
        this._nonceCache.delete(body.from);
        this._releaseReserve(rec);
        const released = this._releaseCoverage(rec);
        delete this.state.inbound[txid];
        this._standbyLocal.delete(txid);
        await this._persist.deleteClaim(`accepted:${txid}`).catch(() => {});
        this._emit('settlement.updated', {
          direction: 'inbound',
          txid,
          status: 'FAILED',
          rawStatus: 'FAILED',
          action: rec.action,
          from: rec.from,
          amountPoa: rec.amountPoa,
          explorer: this.client.explorerTxUrl(txid),
          result: null,
          error: errMsg,
          payouts: []
        });
        throw refuse(`Broadcast to minepoa failed; nothing was booked: ${errMsg}`, 502, 'BROADCAST_FAILED', {
          coverageReleased: released
        });
      }
    }
    this._emit('settlement.updated', this._inboundView(rec));
    if (this.passMode) await this.maybePass({ force: true, budgetMs: 8000 }).catch(() => {});
    return this._inboundView(this.state.inbound[txid] || rec, { acceptedBy: 'standby' });
  },

  _inboundView(rec, extra = {}) {
    const payouts = this._outboundForSource(rec.txid).map((o) => this._outboundView(o));
    return {
      direction: 'inbound',
      txid: rec.txid,
      status:
        rec.status === 'BOOKED'
          ? 'CONFIRMED'
          : rec.status === 'BROADCAST' || rec.status === 'SEEN'
            ? 'PENDING_CONFIRMATION'
            : rec.status,
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
  },

  async _confirmInbound() {
    const blockedFrom = new Set();
    for (const rec of Object.values(this.state.inbound).sort((a, b) => a.seq - b.seq)) {
      if (!OPEN_IN.has(rec.status) || rec.status === 'SUBMITTING') continue;
      if (blockedFrom.has(rec.from)) continue;
      let tx;
      try {
        tx = await this.client.getTx(rec.txid, { isolateBusy: true });
      } catch (err) {
        this._tickErrors.push(err.message);
        if (this._ledgerDown(err)) return;
        const verdict = await this._inboundFallback(rec);
        if (verdict === 'not_found') tx = null;
        else {
          blockedFrom.add(rec.from);
          continue;
        }
      }
      if (!tx) {
        if (now() - rec.submittedAt > this.inboundExpireMs) {
          if (!(await this._safeToExpire(rec))) continue;
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
      if (booked === false) return;
    }
  },

  _ledgerDown(err) {
    if (this.ledgerProbe?.hold?.()) return true;
    if (err && (err.busy || err.name === 'BusyError')) return false;
    const msg = String(err?.message || err || '');
    if (/cannot answer for|-> HTTP \d{3}/.test(msg)) return false;
    return true;
  },

  async _inboundFallback(rec) {
    if (typeof this.client.receiptLookup !== 'function') return 'unknown';
    const r = await this.client.receiptLookup(rec.txid).catch((err) => ({ state: 'unavailable', error: err.message }));
    if (r.state === 'unknown' || r.state === 'rejected') return 'not_found';
    if (r.state === 'known') return 'known';
    if (r.error && isLedgerBusy(r.error)) this._tickErrors.push(r.error);
    else if (r.error && this.logger) this.logger(`inbound ${String(rec.txid).slice(0, 16)}: receipt gave no verdict: ${r.error}`);
    return 'unknown';
  },

  async _safeToExpire(rec) {
    const ix = this.indexer;
    if (!ix || typeof ix.lookupTx !== 'function') return true;
    try {
      const look = await ix.lookupTx(rec.txid);
      if (look && look.found) {
        if (this.logger) {
          this.logger(`inbound ${String(rec.txid).slice(0, 16)}: minepoa does not know it but ${ix.name || 'POAScan'} does; not expired`);
        }
        return false;
      }
    } catch {
      // no definite answer from the index: minepoa's definite not-found stands
    }
    return true;
  },

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
  },

  async _claimBetTicket(rec, b) {
    const parsed = parseDiceMemo(b.memo || '');
    if (!parsed.valid || parsed.action !== 'BET') return undefined;
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
  },

  _markNeedsReview(rec, tx, { reviewReason = null, error }) {
    rec.status = 'NEEDS_REVIEW';
    if (tx) rec.ledger = { atts: tx.atts, final: tx.final };
    if (reviewReason) rec.reviewReason = reviewReason;
    rec.error = error;
    this._releaseReserve(rec);
    this._releaseCoverage(rec);
    this._resolveGroup(rec);
    this._save();
    this._emit('settlement.updated', this._inboundView(rec));
  },

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

    const predates = Boolean(this.state.createdAt && Number(b.ts || 0) < this.state.createdAt);
    const replay = rec.discoveredBy === 'ledger-scan' && (predates || this._outflowRefs().has(rec.txid.slice(0, 16)));
    if (replay && rec.action === 'BET' && !this.engine.processedTxids.has(rec.txid)) {
      this._markNeedsReview(rec, tx, {
        error:
          'Bet predates this vault state (state was lost); not re-rolled. It is settled from its on-chain payout if one exists, otherwise it stays in review.'
      });
      return;
    }
    if (rec.action === 'BET' && rec.discoveredBy === 'ledger-scan' && !this.engine.processedTxids.has(rec.txid)) {
      if (this._preBinding(rec.txid, b.ts)) {
        this._markNeedsReview(rec, tx, {
          reviewReason: 'LEDGER_ONLY_BET',
          error:
            "Bet found only on the ledger and older than this vault store's binding: not rolled and not paid. Listed in the audit for operator review."
        });
        return;
      }
    }
    if (
      rec.action === 'BET' &&
      rec.seedCommit &&
      !this.engine.processedTxids.has(rec.txid) &&
      rec.seedCommit.hash !== this.engine.seedManager.currentSeedHash
    ) {
      this._markNeedsReview(rec, tx, {
        reviewReason: 'SEED_COMMITMENT_CHANGED',
        error: 'The server seed changed since this bet was accepted; it is not re-rolled with a different seed. Operator review.'
      });
      return;
    }
    // Non-terminal hold: keep rec.reserve intact while open!
    if (this.tradingHold() && !replay && HOLD_ACTIONS.has(rec.action) && !this.engine.processedTxids.has(rec.txid)) {
      rec.ledger = { atts: tx.atts, final: tx.final };
      rec.heldBy = this.tradingHold()?.status || this.reconcile.status;
      return true;
    }
    let result;
    if (!this.engine.processedTxids.has(rec.txid) && rec.action === 'BET' && !rec.coverage) {
      const parsedBet = parseDiceMemo(b.memo || '');
      const q = parsedBet.valid
        ? this.engine.quoteBet({
            address: b.from,
            amountPoa: b.amount,
            targetBps: parsedBet.targetBps,
            direction: parsedBet.direction
          })
        : null;
      if (q && q.valid) {
        const cov = await this.betCoverage(BigInt(q.payoutOnWinMicros), { reserveKey: rec.txid });
        if (cov.unknown) {
          rec.ledger = { atts: tx.atts, final: tx.final };
          rec.heldBy = cov.code;
          rec.error = `Held: ${cov.reason}`;
          return true;
        }
        if (!cov.ok) {
          result = this.engine.queueRefund({
            sourceTxid: rec.txid,
            to: b.from,
            amountPoa: b.amount,
            reason: `bank cannot cover worst-case payout ${q.payoutOnWinPoa} POA`,
            full: true,
            ts: b.ts || Math.floor(now() / 1000)
          });
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
      if (ticket === null) return false; // non-terminal: keep rec.reserve intact!
      if (
        ticket &&
        rec.seedCommit &&
        ticket.serverSeedHash &&
        ticket.serverSeedHash !== rec.seedCommit.hash &&
        !this.engine.processedTxids.has(rec.txid)
      ) {
        this._markNeedsReview(rec, tx, {
          reviewReason: 'SEED_COMMITMENT_CHANGED',
          error: 'The stored settlement ticket uses a different server seed than the one committed for this bet; not rolled. Operator review.'
        });
        return;
      }
      this._releaseReserve(rec);
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
    this._releaseReserve(rec);
    rec.status = 'BOOKED';
    rec.bookedAt = now();
    rec.ledger = { atts: tx.atts, final: tx.final };
    const pf = result?.provablyFair;
    rec.result = result
      ? {
          action: result.action,
          won: result.won,
          rollDisplay: result.rollDisplay,
          wagerPoa: result.wagerPoa,
          payoutPoa: result.payoutPoa,
          sharesMinted: result.sharesMinted,
          netPayoutPoa: result.netPayoutPoa,
          reason: result.reason,
          ...(pf
            ? {
                provablyFair: {
                  seedEpochId: pf.seedEpochId,
                  serverSeedHash: pf.serverSeedHash,
                  clientSeed: pf.clientSeed,
                  nonce: pf.nonce
                }
              }
            : {})
        }
      : null;
    if (rec.action === 'BET') this._invalidatePlayTime();
    this._resolveGroup(rec);
    this._save();
    this._releaseCoverage(rec);
    this._emit('settlement.updated', this._inboundView(rec));
  },

  _seedCommit() {
    return { epoch: this.engine.seedManager.epochId, hash: this.engine.seedManager.currentSeedHash, at: now() };
  },

  async _acceptedClaim(t, memo) {
    if (typeof this.store.peek !== 'function') return null;
    const a = await this.store.peek(`accepted:${t.id}`);
    if (!a || a.txid !== t.id || a.from !== t.from || String(a.memo) !== String(memo) || toMicros(a.amountPoa) !== toMicros(t.amount)) {
      return null;
    }
    const fields = { acceptedBy: 'standby', submittedAt: Number(a.submittedAt) || now() };
    if (a.action === 'BET' && a.seedCommit && a.seedCommit.hash) {
      fields.seedCommit = { epoch: a.seedCommit.epoch, hash: a.seedCommit.hash, at: a.seedCommit.at };
    }
    if (a.coverage && a.coverage.key && a.coverage.micros) {
      fields.coverage = { key: String(a.coverage.key), micros: String(a.coverage.micros) };
    }
    if (a.groupId) {
      if (!this.state.groups[a.groupId]) {
        const g = await this.store.peek(`group:${a.groupId}`);
        if (g) {
          this.state.groups[a.groupId] = {
            count: g.count,
            address: g.address,
            resolved: 0,
            done: 0,
            wins: 0,
            losses: 0,
            netMicros: '0',
            completed: false,
            createdAt: g.createdAt || now()
          };
        }
      }
      if (this.state.groups[a.groupId]) fields.groupId = a.groupId;
    }
    return fields;
  }
};
