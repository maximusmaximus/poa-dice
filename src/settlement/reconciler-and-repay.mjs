// @ts-nocheck
/**
 * settlement/reconciler-and-repay.mjs — Ledger-first reconciliation, trading holds,
 * receipt-only payout verification/re-pay, chain audit, and settlement summary.
 */
import { fromMicros, parseDiceMemo, toMicros } from '../crypto-poa.mjs';
import {
  LEADER_WAITING,
  NO_ACTIVE_LEADER,
  OPEN_IN,
  STANDBY_STATUS_REFRESH_MS,
  TERMINAL_OUT,
  WRITER_LEASE_RENEWING_REASON,
  bad,
  now,
  tradingLabel
} from './constants.mjs';

export function repayMemo(memo) {
  const base = String(memo || '');
  return base.includes(':repay=') ? base : `${base}:repay=1`.slice(0, 500);
}

export const reconcilerAndRepayMethods = {
  _repayCandidate(rec) {
    if (!rec) return 'unknown order';
    if (rec.repay) {
      return `this order was already re-paid once (${rec.repay.original?.txid ? `original ${String(rec.repay.original.txid).slice(0, 16)}` : 'see repay record'})`;
    }
    if (rec.status !== 'CONFIRMED') return `the order is ${rec.status}, not CONFIRMED (only a payout marked paid can be re-paid)`;
    if (!rec.txid) return 'the order has no payout txid';
    if (rec.recoveredFromLedger || rec.matchedFromLedger) return 'the order was matched to a transfer found on the ledger';
    if (rec.confirmedVia !== 'receipt') return `the payout was confirmed by the ${rec.confirmedVia || 'ledger'}, not by a receipt alone`;
    if (now() - Number(rec.confirmedAt || rec.sentAt || 0) <= this.stuckAfterMs) {
      return `the payout was marked paid less than ${Math.round(this.stuckAfterMs / 60000)} min ago; the ledger may still be catching up`;
    }
    return null;
  },

  async _verifyRepay(rec) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
    const done = (refusal, extra = {}) => ({ ok: !refusal, refusal: refusal || null, checks, ...extra });
    const why = this._repayCandidate(rec);
    add(
      'order is a receipt-only payout missing from the ledger',
      !why,
      why || `${rec.kind} ${rec.amountPoa} POA to ${rec.to}, payout ${String(rec.txid).slice(0, 16)} (nonce ${rec.nonce ?? '?'}) marked paid from its receipt`
    );
    if (why) return done(why);
    const tag = String(rec.orderId).slice(0, 12);

    if (this.ledgerProbe) {
      await this.ledgerProbe.probe().catch(() => {});
      const st = this.ledgerProbe.view().status;
      add('minepoa ledger healthy', st === 'OK', `ledger probe: ${st}${this.ledgerProbe.lastError ? ` (${String(this.ledgerProbe.lastError).slice(0, 120)})` : ''}`);
      if (st !== 'OK') return done(`the minepoa ledger is ${st} right now; a re-pay needs a healthy ledger read`);
    }

    const prevErrors = this._tickErrors;
    this._tickErrors = [];
    let row;
    try {
      row = await this._scanBank();
    } finally {
      const errs = this._tickErrors;
      this._tickErrors = prevErrors;
      if (errs.length) this._tickErrors.push(...errs);
    }
    const fresh = Boolean(row && !row.fromTrusted && typeof row.effectiveMicros === 'bigint' && this.ledgerIndexComplete);
    add(
      'fresh, complete bank history',
      fresh,
      fresh
        ? `${(row.listedIds || new Set()).size} bank transfers listed, every outgoing memo indexed`
        : !row
          ? 'the bank address page could not be read'
          : row.fromTrusted
            ? 'only the last trusted read is available (explorer busy)'
            : 'some outgoing memos could not be read'
    );
    if (!fresh) return done("could not read the bank's complete ledger history right now");
    const inBank = row.listedIds.has(rec.txid) || Boolean(this.state.ledgerOut[rec.txid]);
    add('original txid absent from the bank history', !inBank, inBank ? `${rec.txid.slice(0, 16)} IS in the bank's ledger history` : `${rec.txid.slice(0, 16)} not listed`);
    if (inBank) return done('the original payout is on the ledger (bank history)');
    const tagged = Object.entries(this.state.ledgerOut || {}).filter(
      ([, o]) => o.ord === tag || (o.to === rec.to && toMicros(String(o.amountPoa)) === toMicros(rec.amountPoa) && String(o.memo || '').includes(`:ord=${tag}`))
    );
    add(`no other bank transfer tagged ord=${tag}`, !tagged.length, tagged.length ? `found ${tagged.map(([id]) => id.slice(0, 16)).join(', ')}` : 'none');
    if (tagged.length) return done(`the ledger already has bank transfer ${tagged[0][0].slice(0, 16)} tagged for this order`);
    const dup = this._ledgerPaidFor(rec);
    add('no other payout or refund for the same bet', !dup, dup ? `${dup.txid.slice(0, 16)}: ${dup.why}` : 'none');
    if (dup) return done(`the ledger already has ${dup.txid.slice(0, 16)} for this bet (${dup.why})`);

    const NAME = 'explorer: original txid unknown';
    let mp;
    try {
      mp = (await this.client.getTx(rec.txid)) ? 'found' : 'not found';
    } catch (err) {
      mp = `no answer (${String(err.message || err).slice(0, 160)})`;
    }
    if (mp === 'found') {
      add(NAME, false, `minepoa explorer has ${rec.txid.slice(0, 16)}`);
      return done('the minepoa explorer knows the original payout txid');
    }
    const ix = this.indexer;
    if (!ix) {
      add(NAME, false, `minepoa: ${mp}; no independent index (POAScan) configured, and minepoa alone cannot prove a tx was dropped`);
      return done('no independent source could confirm the original txid is unknown');
    }
    const src = ix.name || 'POAScan';
    let look;
    try {
      look = await ix.lookupTx(rec.txid);
    } catch (err) {
      add(NAME, false, `minepoa: ${mp}; ${src}: no answer (${String(err.message || err).slice(0, 100)})`);
      return done(`${src} could not answer for the original txid, and minepoa alone cannot prove it was dropped`);
    }
    if (look.found) {
      const t = look.tx || {};
      const how = [t.final ? 'final' : 'not final', t.atts ? `${t.atts} atts` : null, t.checkpointHeight ? `in checkpoint h${t.checkpointHeight}` : null, t.nonce != null ? `nonce ${t.nonce}` : null]
        .filter(Boolean)
        .join(', ');
      add(NAME, false, `minepoa: ${mp}; ${src} HAS ${rec.txid.slice(0, 16)} (${how}${t.amount ? `, ${t.amount} POA to ${t.to}` : ''})`);
      return done(`${src} has the original payout txid${t.final ? ' as final' : ''}: the payout reached the ledger, so it must not be paid again`);
    }
    const hist = {};
    for (const [label, addr] of [
      ['bank', this.bankAddress],
      ['recipient', rec.to]
    ]) {
      try {
        hist[label] = await ix.addressTxs(addr);
      } catch (err) {
        add(NAME, false, `minepoa: ${mp}; ${src} tx lookup: not found; ${src} ${label} history unreadable (${String(err.message || err).slice(0, 80)})`);
        return done(`could not read the ${label}'s history from ${src}`);
      }
      const lid = String(rec.txid).toLowerCase();
      if (hist[label].some((t) => t.id === lid)) {
        add(NAME, false, `minepoa: ${mp}; ${src} lists ${rec.txid.slice(0, 16)} in the ${label}'s history`);
        return done(`${src} lists the original payout in the ${label}'s history`);
      }
      const taggedList = hist[label].filter((t) => t.from === this.bankAddress && t.to === rec.to && String(t.memo || '').includes(`:ord=${tag}`));
      if (taggedList.length) {
        add(NAME, false, `minepoa: ${mp}; ${src} lists bank transfer ${taggedList[0].id.slice(0, 16)} tagged ord=${tag} in the ${label}'s history`);
        return done(`${src} lists a bank transfer already tagged for this order`);
      }
    }
    add(
      NAME,
      true,
      `${src}: not found (definite 404); absent from ${src} bank history (${hist.bank.length} txs) and recipient history (${hist.recipient.length} txs); minepoa: ${mp}`
    );

    let rrow;
    try {
      rrow = await this.client.getAddress(rec.to);
    } catch (err) {
      add('recipient history read', false, `could not read ${rec.to} (${String(err.message || err).slice(0, 120)})`);
      return done("could not read the recipient's ledger history right now");
    }
    const rtxs = (rrow.txs || []).filter((t) => t && t.id);
    if (rtxs.some((t) => t.id === rec.txid)) {
      add('original txid absent from the recipient history', false, `${rec.txid.slice(0, 16)} IS in ${rec.to}'s history`);
      return done("the original payout is in the recipient's ledger history");
    }
    add('original txid absent from the recipient history', true, `${rtxs.length} transfers listed for ${rec.to}`);
    const same = rtxs.filter((t) => t.from === this.bankAddress && t.to === rec.to && toMicros(String(t.amount || '0')) === toMicros(rec.amountPoa));
    for (const t of same) {
      let memo = t.memoKnown ? String(t.memo || '') : undefined;
      if (memo === undefined) {
        try {
          memo = await this.client.getMemo(t.id);
        } catch (err) {
          add('recipient: bank transfers of this amount checked', false, `memo of ${t.id.slice(0, 16)} unreadable (${String(err.message || err).slice(0, 80)})`);
          return done("could not read every matching transfer in the recipient's history");
        }
      }
      if (memo === null || memo === undefined || String(memo).includes(`:ord=${tag}`)) {
        add('recipient: bank transfers of this amount checked', false, `${t.id.slice(0, 16)} pays ${rec.amountPoa} POA ${memo == null ? '(memo unknown)' : `tagged ord=${tag}`}`);
        return done(`the recipient already received ${t.id.slice(0, 16)} for this order (or its memo cannot be read)`);
      }
    }
    add('recipient: bank transfers of this amount checked', true, `${same.length} bank transfer(s) of ${rec.amountPoa} POA, none tagged ord=${tag}`);

    if (!Number.isInteger(rec.nonce)) {
      add('original nonce used by another bank tx', false, 'the original nonce is unknown');
      return done("the original payout's nonce is unknown, so it cannot be proven that it can never land");
    }
    const consumer = await this._nonceConsumer(rec.nonce, rec.txid);
    if (consumer === undefined) {
      add('original nonce used by another bank tx', false, 'minepoa could not answer');
      return done('could not check which bank tx used the original nonce right now');
    }
    add(
      'original nonce used by another bank tx',
      Boolean(consumer),
      consumer ? `nonce ${rec.nonce} was used by final bank tx ${consumer.slice(0, 16)}, so the original body can never land` : `no final bank tx with nonce ${rec.nonce} found`
    );
    if (!consumer) return done(`no other final bank tx with nonce ${rec.nonce} was found, so the original payout could still land`);
    return done(null, { nonceConsumer: consumer });
  },

  _repayView(rec, v, claim) {
    return {
      order: {
        orderId: rec.orderId,
        kind: rec.kind,
        to: rec.to,
        amountPoa: rec.amountPoa,
        status: rec.status,
        originalTxid: rec.repay?.original?.txid || rec.txid,
        originalNonce: rec.repay?.original?.nonce ?? rec.nonce ?? null,
        confirmedVia: rec.repay?.original?.confirmedVia || rec.confirmedVia || null,
        receipt: rec.repay?.original?.receipt || rec.receipt || null
      },
      wouldSend:
        v && v.ok
          ? {
              from: this.bankAddress,
              to: rec.to,
              amountPoa: rec.amountPoa,
              memo: repayMemo(rec.memo),
              nonce: `a new bank nonce, chosen when it is signed (never ${rec.nonce})`,
              path: 'queued as a normal payout: signed, saved to the vault store, then broadcast (never twice)'
            }
          : null,
      eligible: Boolean(v && v.ok),
      refusal: v ? v.refusal : null,
      checks: v ? v.checks : [],
      requested: claim || null,
      repay: rec.repay || null
    };
  },

  async _repayClaim(orderId) {
    if (typeof this.store.peek !== 'function') return null;
    return this.store.peek(`repay:${orderId}`);
  },

  async repayMissingPayout({ orderId, confirm = false }) {
    if (!/^[0-9a-f]{24}$/.test(String(orderId || ''))) throw bad('orderId: the 24-hex order id (see /api/audit/chain confirmedNotOnLedger)');
    await this.ready();
    await (this.passMode ? this.maybePass({ force: true, budgetMs: 8000 }) : this.tick()).catch(() => {});
    if (!this.writer.canWrite()) await this._observe().catch(() => {});
    let rec = this.state.outbound[orderId];
    if (!rec) throw bad(`unknown order ${orderId}`, 404);
    const claim = await this._repayClaim(orderId).catch(() => undefined);
    if (claim === undefined) throw bad('the vault store could not be read; try again', 503);
    if (rec.repay || (claim && confirm)) {
      return {
        mode: confirm ? 'confirm' : 'preview',
        alreadyRequested: true,
        ...this._repayView(rec, null, claim),
        refusal: rec.repay ? 'this order was already re-paid once' : 'a re-pay of this order was already requested once; the bank writer applies it on its next pass'
      };
    }
    const v = await this._verifyRepay(rec);
    if (!confirm) return { mode: 'preview', ...this._repayView(rec, v, claim) };
    if (!v.ok) throw Object.assign(bad(`re-pay refused: ${v.refusal}`, 409), { details: this._repayView(rec, v, claim) });
    const value = {
      orderId,
      originalTxid: rec.txid,
      originalNonce: rec.nonce ?? null,
      to: rec.to,
      amountPoa: rec.amountPoa,
      nonceConsumer: v.nonceConsumer,
      requestedAt: new Date(now()).toISOString()
    };
    const res = await this.store.claim(`repay:${orderId}`, value);
    if (!res.claimed) {
      return { mode: 'confirm', alreadyRequested: true, ...this._repayView(rec, null, res.value), refusal: 'a re-pay of this order was already requested once' };
    }
    if (this.logger) {
      this.logger(`admin re-pay requested for order ${orderId} (${rec.amountPoa} POA to ${rec.to}; original ${rec.txid.slice(0, 16)} never reached the ledger)`);
    }
    if (this.passMode) await this.maybePass({ force: true, budgetMs: 8000 }).catch(() => {});
    else await this.tick().catch(() => {});
    rec = this.state.outbound[orderId] || rec;
    return {
      mode: 'confirm',
      requested: res.value,
      applied: Boolean(rec.repay),
      order: this._outboundView(rec),
      repay: rec.repay || null,
      repayBlocked: rec.repayBlocked || null
    };
  },

  async _applyRepays() {
    if (!this.writer.canWrite()) return 0;
    let applied = 0;
    for (const rec of Object.values(this.state.outbound)) {
      if (rec.repay || rec.status !== 'CONFIRMED' || rec.confirmedVia !== 'receipt') continue;
      let claim;
      try {
        claim = await this._repayClaim(rec.orderId);
      } catch {
        this._tickErrors.push(`repay ${rec.orderId.slice(0, 12)}: store unavailable`);
        continue;
      }
      if (!claim) continue;
      if (rec.repayBlocked && now() - Number(rec.repayBlocked.checkedAt || 0) < 60000) continue;
      if (claim.originalTxid !== rec.txid || claim.to !== rec.to || toMicros(String(claim.amountPoa)) !== toMicros(rec.amountPoa)) {
        rec.repayBlocked = { at: now(), checkedAt: now(), reason: 'the recorded request does not match the stored order' };
        this._save();
        continue;
      }
      const v = await this._verifyRepay(rec);
      if (!v.ok) {
        rec.repayBlocked = { at: rec.repayBlocked?.reason === v.refusal ? rec.repayBlocked.at : now(), checkedAt: now(), reason: v.refusal };
        this._save();
        if (this.logger) this.logger(`admin re-pay for order ${rec.orderId} not applied yet: ${v.refusal}`);
        continue;
      }
      const original = {
        txid: rec.txid,
        nonce: rec.nonce ?? null,
        confirmedVia: rec.confirmedVia,
        confirmedAt: rec.confirmedAt ? new Date(rec.confirmedAt).toISOString() : null,
        receipt: rec.receipt || null
      };
      rec.superseded = rec.superseded || [];
      rec.superseded.push({
        txid: rec.txid,
        nonce: rec.nonce ?? null,
        error: 'marked paid from a receipt but never in the ledger history; superseded by an admin re-pay',
        reason: 'REPAY_NOT_ON_LEDGER',
        at: now()
      });
      rec.repay = { at: now(), requestedAt: claim.requestedAt || null, original, nonceConsumer: v.nonceConsumer, checks: v.checks.map((c) => c.name) };
      rec.repayBlocked = null;
      rec.memo = repayMemo(rec.memo);
      rec.resigns = (rec.resigns || 0) + 1;
      Object.assign(rec, {
        status: 'QUEUED',
        txid: null,
        body: null,
        nonce: null,
        claimedNonce: null,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        rejection: null,
        nonceRule: null,
        forceRebroadcast: false
      });
      for (const k of ['confirmedAt', 'confirmedVia', 'receipt', 'sentAt', 'signedAt', 'nextReceiptCheckAt', 'lastBroadcastAt', 'nextRebroadcastAt', 'rebroadcasts']) {
        delete rec[k];
      }
      const item = this.engine.outboundQueue.find((x) => x.orderId === rec.orderId);
      if (item) {
        item.status = 'IN_SETTLEMENT';
        item.ledgerTxid = null;
        this.engine._saveToDisk();
      }
      this._save();
      this._emit('settlement.updated', this._outboundView(rec));
      if (this.logger) {
        this.logger(`admin re-pay applied for order ${rec.orderId}: original ${original.txid.slice(0, 16)} superseded, requeued (new body, new nonce)`);
      }
      applied += 1;
    }
    return applied;
  },

  async ensureReconciled() {
    const standby = this.writer.status === 'STANDBY';
    if (standby && this.passMode) await this._observe(STANDBY_STATUS_REFRESH_MS).catch(() => {});
    else if (standby ? now() - this._sharedReadAt > STANDBY_STATUS_REFRESH_MS : !this.reconcile.at) await this.tick().catch(() => {});
    if (this.ledgerProbe) await this.ledgerProbe.maybeProbe().catch(() => {});
    return this.tradingHold();
  },

  tradingHold() {
    if (!this._loaded) {
      return {
        status: 'SIGNER_READ_ONLY',
        reason: `Vault state is not loaded yet (${this.vaultLoad.lastError || 'loading'}). Read-only until a load succeeds; retried automatically.`,
        writer: 'VAULT_NOT_LOADED'
      };
    }
    if (!this.writer.canWrite() && this.writer.status === 'STANDBY') return this._standbyHold();
    const wh = this.writer.hold();
    if (wh) return wh;
    if (this._waitingOnTakeover()) return this._waitingHold();
    return this._leaderHold();
  },

  _writerRefusal() {
    return this.writer.hold() || { status: 'SIGNER_READ_ONLY', reason: WRITER_LEASE_RENEWING_REASON, writer: 'LEASE_RENEWING' };
  },

  _standbyHold() {
    if (!this._sharedFresh() && this._sharedWaitingLive()) {
      return { status: 'RECONCILING', reason: this.shared.hold?.reason || this._waitingReason(), writer: LEADER_WAITING };
    }
    if (!this._sharedFresh()) {
      const age = this.shared?.at ? `${Math.round((now() - Number(this.shared.at)) / 1000)} s ago` : 'never';
      const good = this.shared?.goodAt ? `${Math.round((now() - Number(this.shared.goodAt)) / 1000)} s ago` : 'never';
      return {
        status: NO_ACTIVE_LEADER,
        reason: `No settlement pass has completed recently (last good pass: ${good}; last status: ${age}; limit ${Math.round(this.leaderStatusMaxAgeMs / 1000)} s). Bets and withdrawals are refused until one does.`,
        writer: NO_ACTIVE_LEADER
      };
    }
    if (this.shared.hold) return { status: this.shared.hold.status, reason: this.shared.hold.reason };
    return this.ledgerProbe ? this.ledgerProbe.hold() : null;
  },

  _leaderHold() {
    if (this.reconcile && this.reconcile.status !== 'OK') {
      const st = this.reconcile.status;
      return { status: st === 'SOLVENCY_HOLD' || st === 'FOREIGN_OUTFLOW_HOLD' ? st : 'RECONCILING', reason: this.reconcile.reason };
    }
    return this.ledgerProbe ? this.ledgerProbe.hold() : null;
  },

  _knownOutTxids() {
    const known = new Set();
    for (const o of Object.values(this.state.outbound)) {
      if (o.txid) known.add(o.txid);
      for (const x of o.superseded || []) if (x.txid) known.add(x.txid);
    }
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) {
      if (o && o.knownCompacted) known.add(id);
    }
    for (const id of this.engine.recoveredOutflows.keys()) known.add(id);
    return known;
  },

  _knownOrderTags() {
    const tags = new Set();
    for (const o of Object.values(this.state.outbound)) tags.add(o.orderId.slice(0, 12));
    for (const item of this.engine.outboundQueue) tags.add(String(item.orderId).slice(0, 12));
    return tags;
  },

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
  },

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
  },

  _outflowRefs() {
    const refs = new Set();
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) {
      if (this.writer.binding && !this._preBinding(id, o.ts)) continue;
      for (const part of String(o.memo || '').split(':')) if (/^[0-9a-f]{16}$/.test(part)) refs.add(part);
    }
    return refs;
  },

  async _claimDecision(txid, decision) {
    const res = await this._persist.claim(`reconcile:${txid}`, decision);
    return res.value;
  },

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
      return this.engine.applyRecoveredBetRefund({
        betTxid: d.betTxid,
        address: d.to,
        refundMicros: BigInt(d.amountMicros),
        refundTxid: d.txid,
        ts: d.ts
      });
    }
    return this.engine.applyRecoveredOutflow({
      txid: d.txid,
      to: d.to,
      amountMicros: BigInt(d.amountMicros),
      memo: d.memo,
      ts: d.ts
    });
  },

  async _reconcile(row) {
    const prevStatus = this.reconcile.status;
    const set = (status, reason, extra = {}) => {
      this.reconcile = { ...this.reconcile, status, reason, at: now(), ...extra };
      if (prevStatus !== status) this._emit('settlement.reconcile', { status, reason });
    };
    if (!row || row.effectiveMicros === null || row.effectiveMicros === undefined) {
      return set('PENDING', 'Waiting for a trustworthy bank balance from minepoa before reopening bets and withdrawals.');
    }
    if (row.historyComplete === false) {
      return set(
        'SOLVENCY_HOLD',
        `The bank's full ledger history could not be verified (${row.historyReason || 'unknown'}), so its balance cannot be trusted; bets and withdrawals are paused until it can.`
      );
    }
    if (!this.ledgerIndexComplete) {
      return set('PENDING', "Still indexing the bank's outgoing transfers on minepoa (memos); bets and withdrawals reopen once every outflow is accounted for.");
    }
    try {
      const known = this._knownOutTxids();
      const outs = Object.entries(this.state.ledgerOut || {});
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
          if (this.writer.binding && !this._preBinding(id, o.ts)) continue;
          const memo = String(o.memo || '');
          if (memo.startsWith(`DICE1:WIN:${tag}:`) || memo.startsWith(`DICE1:REFUND:${tag}:`)) {
            match = { id, o, kind: memo.startsWith('DICE1:WIN:') ? 'BET_WIN' : 'BET_REFUND' };
            break;
          }
        }
        if (!match) {
          rec.error =
            'Bet predates this vault state (state was lost) and no payout or refund for it is on the ledger: treated as unresolved (a loss leaves no payout). Not re-rolled; operator review.';
          continue;
        }
        if (!(await this._outFinal(match.id))) continue;
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
          ? {
              action: result.action,
              won: result.won,
              rollDisplay: result.rollDisplay,
              rollVerified: false,
              wagerPoa: result.wagerPoa,
              payoutPoa: result.payoutPoa || result.refundedPoa,
              payoutTxid: match.id
            }
          : null;
        this._invalidatePlayTime();
        this._save();
        this._emit('settlement.updated', this._inboundView(rec));
      }

      const refs = this._outflowRefs();
      const replaying = Object.values(this.state.inbound).some(
        (r) =>
          OPEN_IN.has(r.status) &&
          r.discoveredBy === 'ledger-scan' &&
          ((this.state.createdAt && Number(r.ledgerTs || 0) < this.state.createdAt) || refs.has(r.txid.slice(0, 16)))
      );
      if (replaying) {
        return set('PENDING', 'Replaying ledger deposits / withdrawals into the rebuilt vault; bets and withdrawals reopen when done.');
      }
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
        if (reviewTag && review.some((r) => r.txid.startsWith(reviewTag[1]) && r.status === 'NEEDS_REVIEW')) continue;
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

      const solvency = () => {
        let pendingOut = 0n;
        for (const o of Object.values(this.state.outbound)) {
          if (o.repayment?.status === 'HELD') continue;
          if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT' && o.status !== 'SIGNED') pendingOut += toMicros(o.amountPoa);
        }
        for (const item of this.engine.outboundQueue) {
          if (item.status === 'PENDING' && !this.state.outbound[item.orderId]) pendingOut += BigInt(item.amountMicros);
        }
        return {
          required: this.engine.bankNavMicros + this.engine.devReserveMicros + this.engine.incentivePoolMicros + pendingOut,
          available: row.effectiveMicros - this._inFlightOutMicros(row.listedIds)
        };
      };
      let { required, available } = solvency();
      if (available < required && this._repairHalfAppliedRefunds(required - available)) ({ required, available } = solvency());
      const inReview = Object.values(this.state.inbound)
        .filter((r) => r.status === 'NEEDS_REVIEW')
        .map((r) => r.txid);
      const audit = { onChainPoa: fromMicros(available < 0n ? 0n : available), requiredPoa: fromMicros(required), ok: available >= required };
      audit.foreignOutflows = this.foreign.length;
      if (!audit.ok) {
        return set(
          'SOLVENCY_HOLD',
          `Books (${fromMicros(required)} POA) exceed the confirmed on-chain bank balance (${fromMicros(available < 0n ? 0n : available)} POA); bets and withdrawals are paused until reconciled.`,
          { inReview, audit, recovered: this.reconcile.recovered + recovered }
        );
      }
      const unacked = this.foreign.filter((f) => !f.acknowledged);
      if (unacked.length) {
        return set(
          'FOREIGN_OUTFLOW_HOLD',
          `${unacked.length} bank transfer(s) on the ledger were not created by this vault (${unacked.map((f) => f.txid.slice(0, 16)).join(', ')}); bets and withdrawals are paused until an operator acknowledges them.`,
          { inReview, audit, recovered: this.reconcile.recovered + recovered }
        );
      }
      return set('OK', null, { inReview, audit, recovered: this.reconcile.recovered + recovered });
    } catch (err) {
      this._tickErrors.push(`reconcile: ${err.message}`);
      return set(prevStatus === 'OK' ? 'OK' : 'PENDING', prevStatus === 'OK' ? null : `Reconciliation could not finish (${err.message}); retrying.`);
    }
  },

  _repairHalfAppliedRefunds(shortfallMicros) {
    if (!this.writer.canWrite()) return 0;
    const cands = Object.values(this.state.inbound).filter(
      (r) => r.action === 'BET' && r.status === 'BOOKED' && !r.halfApplyRepaired && r.result?.action === 'REFUND_QUEUED' && /^Accounting invariant failed/.test(String(r.result?.reason || ''))
    );
    if (!cands.length) return 0;
    let total = 0n;
    const ok = [];
    for (const r of cands) {
      const win =
        this._outboundForSource(r.txid).some((o) => o.kind === 'BET_WIN_PAYOUT') ||
        this.engine.outboundQueue.some((o) => o.sourceTxid === r.txid && o.kind === 'BET_WIN_PAYOUT');
      const receipt = this.engine.processedTxids.get(r.txid);
      if (win || !receipt || receipt.action !== 'REFUND_QUEUED') continue;
      ok.push(r);
      total += toMicros(r.amountPoa);
    }
    if (!ok.length || shortfallMicros > total) return 0;
    for (const r of ok) {
      const done = this.engine.revertHalfAppliedLoss({ betTxid: r.txid, wagerMicros: toMicros(r.amountPoa) });
      r.halfApplyRepaired = { at: now(), ...done };
      if (this.logger) this.logger(`reconcile: bet ${r.txid.slice(0, 16)} was refunded but its wager was also booked; booking undone (${done.wagerPoa} POA)`);
    }
    this._save();
    return ok.length;
  },

  summary() {
    const count = (list, key) => list.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
    const outs = Object.values(this.state.outbound);
    const ins = Object.values(this.state.inbound);
    const fromWriter = !this.writer.canWrite() && this.writer.status === 'STANDBY' && this._sharedFresh() ? this.shared : null;
    const rec = fromWriter ? fromWriter.reconcile || {} : this.reconcile;
    const bal = this._bankBalanceView();
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
      onChainBankBalancePoa: bal?.onChainBankBalancePoa ?? this.lastBankBalance?.balance ?? (fromWriter ? fromWriter.onChainBankBalancePoa : null) ?? null,
      bankBalance: this.lastBankBalance ? { ...this.lastBankBalance, ...(bal ? { ...bal, balance: bal.onChainBankBalancePoa } : {}) } : null,
      stuckPayouts: this.stuckPayouts(),
      repaymentQueue: this.repaymentQueueView(),
      writer: this.writer.view(),
      leader: this.leaderView(),
      foreignOutflows: fromWriter ? fromWriter.foreignOutflows || [] : this.foreign,
      ledgerIndexComplete: this.ledgerIndexComplete,
      bankHistory: this.bankHistoryView(),
      reconcile: {
        status: rec.status ?? null,
        reason: rec.reason ?? null,
        at: rec.at ? new Date(rec.at).toISOString() : null,
        inReview: rec.inReview,
        audit: rec.audit,
        ...(fromWriter ? { source: 'writer-status' } : {})
      },
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
  },

  async auditAgainstChain() {
    if (this._tickPromise) await this._tickPromise.catch(() => {});
    const prevErrors = this._tickErrors;
    this._tickErrors = [];
    let row;
    try {
      row = await this._scanBankReadOnly();
    } finally {
      this._tickErrors = prevErrors;
    }
    if (!row || row.effectiveMicros === null) throw new Error('Could not read a trustworthy bank balance from minepoa right now');
    const sentUnconfirmed = this._inFlightOutMicros(row.listedIds);
    const onChain = row.effectiveMicros - sentUnconfirmed;
    const unconfirmedIn = 0n;
    let pendingOut = 0n;
    for (const o of Object.values(this.state.outbound)) {
      if (o.repayment?.status === 'HELD') continue;
      if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT' && o.status !== 'SIGNED') pendingOut += toMicros(o.amountPoa);
    }
    for (const item of this.engine.outboundQueue) {
      if (item.status === 'PENDING' && !this.state.outbound[item.orderId]) pendingOut += BigInt(item.amountMicros);
    }
    const booked = this.engine.bankNavMicros + this.engine.devReserveMicros + this.engine.incentivePoolMicros;
    const required = booked + pendingOut;
    const confirmedOnChain = onChain - unconfirmedIn;
    const delta = confirmedOnChain - required;
    const stuck = this.stuckPayouts();
    const confirmedNotOnLedger =
      row.fromTrusted || !this.ledgerIndexComplete || !row.listedIds
        ? []
        : Object.values(this.state.outbound)
            .filter((o) => o.status === 'CONFIRMED' && o.txid && !o.recoveredFromLedger && !row.listedIds.has(o.txid) && now() - Number(o.confirmedAt || o.sentAt || 0) > this.stuckAfterMs)
            .map((o) => ({
              orderId: o.orderId,
              kind: o.kind,
              to: o.to,
              amountPoa: o.amountPoa,
              txid: o.txid,
              nonce: o.nonce ?? null,
              confirmedVia: o.confirmedVia || null,
              receipt: o.receipt || null,
              confirmedAt: o.confirmedAt ? new Date(o.confirmedAt).toISOString() : null,
              repayable: o.confirmedVia === 'receipt',
              repayBlocked: o.repayBlocked || null
            }));
    let rejectedMicros = 0n;
    for (const o of Object.values(this.state.outbound)) if (o.status === 'REJECTED') rejectedMicros += toMicros(o.amountPoa);
    const historyComplete = row.historyComplete !== false;
    const foreign = this._foreignOutflows();
    return {
      ok: delta >= 0n && historyComplete,
      bankAddress: this.bankAddress,
      bankHistory: this.bankHistoryView(),
      onChainBalancePoa: fromMicros(onChain < 0n ? 0n : onChain),
      ...this._bankBalanceView(row),
      balanceFrom: row.fromTrusted ? 'last-trusted-read' : 'ledger',
      trustedBalanceAt: row.fromTrusted ? new Date(row.trustedAt).toISOString() : null,
      trustedBalanceAgeMs: row.fromTrusted ? Math.max(0, now() - row.trustedAt) : null,
      unconfirmedInboundPoa: fromMicros(unconfirmedIn),
      confirmedOnChainPoa: fromMicros(confirmedOnChain < 0n ? 0n : confirmedOnChain),
      internal: {
        bankNavPoa: fromMicros(this.engine.bankNavMicros),
        devReserveUnpaidPoa: fromMicros(this.engine.devReserveMicros),
        incentivePoolPoa: fromMicros(this.engine.incentivePoolMicros),
        outboundNotYetSentPoa: fromMicros(pendingOut),
        outboundRejectedPoa: fromMicros(rejectedMicros),
        outboundSentUnconfirmedPoa: fromMicros(sentUnconfirmed),
        lockedCollateralPoa: fromMicros(this.engine.lockedCollateralMicros),
        lockedCollateralHeal: this.engine.lockHeal || null
      },
      payoutsOk: stuck.length === 0,
      stuckPayouts: stuck,
      confirmedNotOnLedger,
      repaidPayouts: Object.values(this.state.outbound)
        .filter((o) => o.repay)
        .map((o) => ({
          orderId: o.orderId,
          to: o.to,
          amountPoa: o.amountPoa,
          status: o.status,
          txid: o.txid,
          originalTxid: o.repay.original?.txid || null,
          repayAt: new Date(o.repay.at).toISOString()
        })),
      writer: this.writer.view(),
      foreignOutflowsOk: foreign.every((f) => f.acknowledged),
      foreignOutflows: foreign,
      ledgerOnlyBets: Object.values(this.state.inbound)
        .filter((r) => r.status === 'NEEDS_REVIEW' && r.action === 'BET')
        .map((r) => ({ txid: r.txid, from: r.from, amountPoa: r.amountPoa, reason: r.reviewReason || 'PREDATES_STATE', error: r.error })),
      refusedDuplicatePayouts: Object.values(this.state.outbound)
        .filter((o) => o.status === 'REFUSED_DUPLICATE')
        .map((o) => ({ orderId: o.orderId, to: o.to, amountPoa: o.amountPoa, duplicateOf: o.duplicateOf, error: o.lastError })),
      requiredOnChainPoa: fromMicros(required),
      deltaPoa: (delta < 0n ? '-' : '') + fromMicros(delta < 0n ? -delta : delta),
      note:
        delta >= 0n
          ? 'On-chain bank balance covers every booked liability (a surplus can be unbooked transfers or sent payouts the explorer has not reflected yet).'
          : 'SHORTFALL: the on-chain bank balance is below what the internal ledger owes. Payouts beyond the confirmed balance are held.',
      checkpoint: row.checkpoint ?? null,
      checkpointBalancePoa: row.balance,
      balanceSource: this.lastBankBalance?.source || null,
      unbookedDiceTransfers: Object.values(this.state.inbound)
        .filter((r) => OPEN_IN.has(r.status))
        .map((r) => ({ txid: r.txid, from: r.from, amountPoa: r.amountPoa, status: r.status }))
    };
  }
};
