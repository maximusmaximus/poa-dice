// @ts-nocheck
/**
 * settlement/outbound-dispatcher.mjs — Outbound payout queue, strict head-of-line bank nonce
 * assignment, write-ahead broadcast, `:ord=` ledger matching, and rejected-payout reconciliation.
 */
import { buildSignedTransfer, fromMicros, toMicros, txidOf, verifyBody } from '../crypto-poa.mjs';
import { isLedgerBusy } from '../ledger-probe.mjs';
import { TERMINAL_OUT, isRejectedReceipt, now, parseExpectedNonce } from './constants.mjs';

export const outboundDispatcherMethods = {
  _adoptOutbound() {
    let adopted = 0;
    for (const item of this.engine.outboundQueue) {
      if (item.status !== 'PENDING') continue;
      if (!this.state.outbound[item.orderId]) {
        const rec = {
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
          claimedNonce: null,
          attempts: 0,
          resigns: 0,
          nextAttemptAt: 0,
          lastError: null,
          superseded: [],
          createdAt: now()
        };
        this.state.outbound[item.orderId] = rec;
        this._indexOutbound(rec);
        adopted += 1;
      }
    }
    if (adopted) this._save();
    for (const item of this.engine.outboundQueue) {
      if (item.status === 'PENDING' && this.state.outbound[item.orderId]) item.status = 'IN_SETTLEMENT';
    }
    if (adopted) this.engine._saveToDisk();
    return adopted;
  },

  _inFlightOutMicros(listedIds = null) {
    let s = 0n;
    for (const o of Object.values(this.state.outbound)) {
      if (o.repayment?.status === 'HELD') continue;
      const counts = o.status === 'SIGNED' || o.status === 'SENT' || (listedIds && o.status === 'CONFIRMED' && !o.recoveredFromLedger);
      if (!counts) continue;
      if (listedIds && o.txid && listedIds.has(o.txid)) continue;
      s += toMicros(o.amountPoa);
    }
    return s;
  },

  _heldRepaymentMicros() {
    let s = 0n;
    for (const o of Object.values(this.state.outbound)) {
      if (o.repayment?.status !== 'HELD') continue;
      s += toMicros(o.amountPoa);
    }
    return s;
  },

  _bankBalanceView(row = this._balanceRow) {
    if (!row || typeof row.effectiveMicros !== 'bigint') return null;
    const notListed = this._inFlightOutMicros(row.listedIds || new Set());
    const onChain = row.effectiveMicros - notListed;
    return {
      onChainBankBalancePoa: fromMicros(onChain < 0n ? 0n : onChain),
      ledgerBalancePoa: fromMicros(row.effectiveMicros < 0n ? 0n : row.effectiveMicros),
      ourPayoutsNotOnLedgerPoa: fromMicros(notListed)
    };
  },

  _unconfirmedInMicros() {
    let s = 0n;
    for (const r of Object.values(this.state.inbound)) {
      if (r.status === 'BROADCAST' || r.status === 'SEEN') s += toMicros(r.amountPoa);
    }
    return s;
  },

  _backoff(attempts) {
    const base = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, attempts - 1));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  },

  _payoutRetryAt(attempts, err = null) {
    const wait = err?.busy && err.retryAfterMs ? err.retryAfterMs : this._backoff(attempts);
    return now() + Math.min(wait, this.payoutRetryMaxMs);
  },

  async _broadcastSigned(rec) {
    let readErr = null;
    const known = await this.client.getTx(rec.txid).catch((err) => {
      readErr = err;
      return undefined;
    });
    const readBusy = known === undefined && Boolean(readErr?.busy);
    if (known === undefined && !readBusy) {
      rec.nextAttemptAt = this._payoutRetryAt(++rec.attempts);
      rec.lastError = 'minepoa unreachable';
      return false;
    }
    if (known) return this._markSent(rec, {});
    if (!rec.forceRebroadcast && !readBusy) {
      const receipt = await this._receipt(rec.txid);
      if (isRejectedReceipt(receipt)) {
        this._markRejected(rec, String(receipt.error || 'rejected'), 'receipt');
        await this._releaseNonceClaim(rec.nonce, rec.orderId);
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
      this.ledgerProbe?.reportFailure('payout broadcast', err);
      if (err.definitive) {
        const again = await this.client.getTx(rec.txid).catch(() => undefined);
        if (again) return this._markSent(rec, {});
        this._markRejected(rec, String(err.body?.error || err.message || 'rejected'), 'submit');
        await this._releaseNonceClaim(rec.nonce, rec.orderId);
        return false;
      }
      rec.nextAttemptAt = this._payoutRetryAt(rec.attempts, err);
      this._save();
      this._emit('settlement.updated', this._outboundView(rec));
      return false;
    }
  },

  _listedFinal(txid) {
    const o = txid ? this.state.ledgerOut?.[txid] : null;
    return Boolean(o && o.final);
  },

  _markRejected(rec, error, source) {
    const expected = parseExpectedNonce(error);
    if (!rec.rejection || rec.rejection.txid !== rec.txid) {
      rec.rejection = {
        txid: rec.txid,
        nonce: rec.nonce,
        error,
        source,
        expected,
        kind: null,
        firstAt: now(),
        lastCheckAt: 0,
        checks: 0,
        consumedBy: null,
        lastTransient: null
      };
    } else {
      rec.rejection.error = error;
      if (expected !== null) rec.rejection.expected = expected;
    }
    rec.status = 'REJECTED';
    rec.forceRebroadcast = false;
    rec.lastError = `minepoa rejected ${String(rec.txid).slice(0, 16)}: ${error}`;
    this._save();
    this._emit('settlement.updated', this._outboundView(rec));
  },

  _markSent(rec, resp) {
    rec.status = 'SENT';
    rec.sentAt = now();
    rec.lastError = null;
    rec.rejection = null;
    const next = Number(resp.next_nonce);
    if (Number.isInteger(rec.nonce)) {
      this.state.bankNonce = Number.isInteger(next) && next > rec.nonce ? next : rec.nonce + 1;
    }
    this._save();
    this.engine.markOutboundSent(rec.orderId, rec.txid, 'SENT');
    this._emit('settlement.updated', this._outboundView(rec));
    return true;
  },

  _failEngine(rec) {
    const item = this.engine.outboundQueue.find((x) => x.orderId === rec.orderId);
    if (item) {
      item.status = 'FAILED';
      this.engine._saveToDisk();
    }
  },

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
        if (rec.kind === 'BET_WIN_PAYOUT') this._invalidatePlayTime();
        this._save();
        this.engine.markOutboundSent(rec.orderId, rec.txid, 'CONFIRMED');
        this._emit('settlement.updated', this._outboundView(rec));
      } else if (!(tx && tx.invalid) && this._listedFinal(rec.txid)) {
        rec.status = 'CONFIRMED';
        rec.confirmedAt = now();
        rec.confirmedVia = 'ledger-history';
        if (rec.kind === 'BET_WIN_PAYOUT') this._invalidatePlayTime();
        this._save();
        this.engine.markOutboundSent(rec.orderId, rec.txid, 'CONFIRMED');
        this._emit('settlement.updated', this._outboundView(rec));
      } else if (!(tx && tx.invalid)) {
        const receipt = await this._receiptConfirms(rec);
        const receiptUpdated =
          receipt &&
          (!rec.receipt ||
            (receipt.height != null && rec.receipt.height == null) ||
            (receipt.ts != null && rec.receipt.ts == null) ||
            rec.receipt.status !== receipt.status);
        if (receiptUpdated) {
          const isFirst = !rec.receipt;
          rec.receipt = {
            status: receipt.status,
            height: receipt.height ?? rec.receipt?.height ?? null,
            ts: receipt.ts ?? rec.receipt?.ts ?? null,
            next_nonce: Number.isInteger(Number(receipt.next_nonce))
              ? Number(receipt.next_nonce)
              : (rec.receipt?.next_nonce ?? null),
            at: now()
          };
          this._save();
          this._emit('settlement.updated', this._outboundView(rec));
          if (isFirst && this.logger) {
            this.logger(
              `payout ${rec.orderId} has an ${receipt.status} receipt (height ${receipt.height ?? '?'}); waiting for the ledger history to show it before confirming`
            );
          }
        }
      } else if (tx && tx.invalid) {
        rec.status = 'FAILED';
        rec.lastError = 'minepoa marked the payout tx invalid; operator must review';
        this._save();
        this._failEngine(rec);
      }
    }
    // 1b. payouts minepoa refused (or never took)
    await this._reconcilePayouts(recs);
    // 2. head of line: an un-acknowledged signed tx blocks new signing (nonce order)
    const pendingSigned = recs.find((r) => r.status === 'SIGNED');
    if (pendingSigned) {
      if (now() < pendingSigned.nextAttemptAt) return;
      try {
        await this._writeAhead(pendingSigned);
      } catch (err) {
        this._tickErrors.push(`store: ${err.message}`);
        return;
      }
      const ok = await this._broadcastSigned(pendingSigned);
      if (!ok) return;
    }
    // 3. sign + broadcast queued orders, strictly preserving nonce head-of-line order
    const balanceMicros = bankRow && typeof bankRow.effectiveMicros === 'bigint' ? bankRow.effectiveMicros : null;
    const listed = bankRow?.listedIds || null;
    const tagged = new Map();
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) if (o.ord) tagged.set(o.ord, id);
    const claimed = new Set(
      Object.values(this.state.outbound)
        .flatMap((o) => [o.txid, ...(o.superseded || []).map((x) => x.txid)])
        .filter(Boolean)
    );
    const maxPerPass = Number(this.maxPayoutsPerTick) > 0 ? Number(this.maxPayoutsPerTick) : 5;
    let sentThisPass = 0;
    for (const rec of recs) {
      if (rec.status !== 'QUEUED' && rec.status !== 'WAITING_FUNDS') continue;
      const paid = tagged.get(rec.orderId.slice(0, 12));
      if (paid && !claimed.has(paid) && !this._ordFits(paid, this.state.ledgerOut[paid])) {
        const why =
          rec.ordConflict?.why ||
          `bank transfer ${paid.slice(0, 16)} on the ledger is tagged for this order but does not match it`;
        if (rec.lastError !== `not paid: ${why}`) {
          rec.lastError = `not paid: ${why}`;
          this._save();
        }
        if (Number.isInteger(rec.claimedNonce)) return; // holds a bank nonce: never skip ahead
        continue;
      }
      if (paid && !claimed.has(paid)) {
        rec.txid = paid;
        rec.recoveredFromLedger = true;
        rec.nonce = this._txNonce.get(paid) ?? null;
        rec.claimedNonce = null;
        rec.status = 'SENT';
        rec.sentAt = now();
        rec.lastError = null;
        claimed.add(paid);
        this._save();
        this.engine.markOutboundSent(rec.orderId, rec.txid, 'SENT');
        this._emit('settlement.updated', this._outboundView(rec));
        continue;
      }
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
      if (now() < rec.nextAttemptAt) {
        // Strict head-of-line: if this order already holds a claimed bank nonce, block later orders from claiming n+1
        if (Number.isInteger(rec.claimedNonce)) return;
        continue;
      }
      if (balanceMicros === null || !this.ledgerIndexComplete) return;
      const waitingOnReceipt = recs.find((r) => r !== rec && r.status === 'SENT' && !r.receipt && !r.recoveredFromLedger && r.repayment?.status !== 'HELD');
      if (waitingOnReceipt) return;
      const amount = toMicros(rec.amountPoa);
      const spendable = balanceMicros - this._inFlightOutMicros(listed) - this._heldRepaymentMicros();
      if (spendable < amount) {
        if (rec.status !== 'WAITING_FUNDS') {
          rec.status = 'WAITING_FUNDS';
          rec.lastError = `Confirmed on-chain bank balance cannot cover ${rec.amountPoa} POA yet`;
          this._save();
          this._emit('settlement.updated', this._outboundView(rec));
        }
        if (Number.isInteger(rec.claimedNonce)) return;
        continue;
      }
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
        if (Number.isInteger(rec.claimedNonce)) return;
        continue;
      }
      let fence;
      try {
        fence = await this.writer.assertLeader();
      } catch (err) {
        this._tickErrors.push(`signing stopped: ${err.message}`);
        return;
      }
      // Fetch tip parents BEFORE claiming a bank nonce so a transient /api/txs error never strands bank-nonce:<n>
      let parents;
      try {
        parents = await this._parents();
      } catch (err) {
        rec.lastError = err.message;
        this.ledgerProbe?.reportFailure('payout parents (/api/txs)', err);
        rec.nextAttemptAt = now() + this._backoff(++rec.attempts);
        this._save();
        return;
      }
      let nonce;
      try {
        nonce = Number.isInteger(rec.claimedNonce) ? rec.claimedNonce : await this._chooseBankNonce(rec);
        rec.claimedNonce = nonce;
      } catch (err) {
        rec.lastError = `bank nonce: ${err.message}`;
        rec.nextAttemptAt = now() + this._backoff(++rec.attempts);
        this._save();
        return;
      }
      const signed = buildSignedTransfer({
        wallet: this.bankWallet,
        to: rec.to,
        amount: rec.amountPoa,
        memo: rec.memo,
        nonce,
        parents,
        cid: this.client.chainId
      });
      let tx = signed;
      try {
        const res = await this._persist.claim(`payout:${rec.orderId}:${rec.resigns || 0}`, {
          txid: signed.id,
          body: signed.body,
          nonce,
          fence
        });
        if (!res.claimed) {
          const v = res.value || {};
          if (
            !v.body ||
            txidOf(v.body) !== v.txid ||
            v.body.to !== rec.to ||
            toMicros(v.body.amount) !== toMicros(rec.amountPoa) ||
            !verifyBody(v.body, this.bankAddress)
          ) {
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
      rec.claimedNonce = null;
      rec.status = 'SIGNED';
      rec.signedAt = now();
      rec.nonceRule = null;
      try {
        await this._writeAhead(rec);
      } catch (err) {
        this._tickErrors.push(`store: ${err.message}`);
        return;
      }
      const ok = await this._broadcastSigned(rec);
      if (!ok) return;
      const receipt = await this._receipt(rec.txid);
      if (isRejectedReceipt(receipt)) {
        this._markRejected(rec, String(receipt.error || receipt.status || 'rejected'), 'receipt');
        await this._releaseNonceClaim(rec.nonce, rec.orderId);
        return;
      }
      if (receipt && /^(included|final|confirmed)$/i.test(String(receipt.status || ''))) {
        rec.receipt = {
          status: receipt.status,
          height: receipt.height ?? null,
          ts: receipt.ts ?? null,
          next_nonce: Number.isInteger(Number(receipt.next_nonce)) ? Number(receipt.next_nonce) : null,
          at: now()
        };
        this._save();
        sentThisPass += 1;
        if (sentThisPass >= maxPerPass) return;
        continue;
      }
      return;
    }
  },

  _orderForTag(tag) {
    if (!tag) return null;
    const rec = Object.values(this.state.outbound).find((r) => String(r.orderId).slice(0, 12) === tag);
    if (rec) return rec;
    const item = this.engine.outboundQueue.find((x) => String(x.orderId).slice(0, 12) === tag);
    return item
      ? {
          orderId: item.orderId,
          to: item.to,
          amountPoa: item.amountPoa ?? fromMicros(BigInt(item.amountMicros)),
          status: 'QUEUED',
          txid: null,
          engineOnly: true
        }
      : null;
  },

  _ordFits(id, o) {
    if (!o || !o.ord) return false;
    const rec = this._orderForTag(o.ord);
    if (!rec) return false;
    if (rec.txid === id) return true;
    if (this._ordVerdict.get(id) === false) return false;
    if (TERMINAL_OUT.has(rec.status)) return false;
    return o.to === rec.to && toMicros(String(o.amountPoa)) === toMicros(String(rec.amountPoa));
  },

  async _payoutClaims(rec) {
    if (typeof this.store.peek !== 'function') return [];
    const out = [];
    try {
      for (let g = 0; g <= (rec.resigns || 0); g++) {
        const v = await this.store.peek(`payout:${rec.orderId}:${g}`);
        if (v && v.txid) out.push({ gen: g, txid: v.txid, body: v.body || null, nonce: v.nonce ?? v.body?.nonce ?? null });
      }
    } catch {
      return undefined;
    }
    return out;
  },

  _claimPaysOrder(c, rec) {
    const b = c && c.body;
    return Boolean(
      b &&
        txidOf(b) === c.txid &&
        b.from === this.bankAddress &&
        b.to === rec.to &&
        toMicros(String(b.amount)) === toMicros(String(rec.amountPoa)) &&
        verifyBody(b, this.bankAddress)
    );
  },

  async _ordVerdictFor(id, o, rec) {
    if (o.to !== rec.to || toMicros(String(o.amountPoa)) !== toMicros(String(rec.amountPoa))) {
      return {
        match: false,
        why: `tagged for order ${rec.orderId.slice(0, 12)} but pays ${o.amountPoa} POA to ${o.to} (order: ${rec.amountPoa} POA to ${rec.to})`
      };
    }
    if (TERMINAL_OUT.has(rec.status)) {
      return {
        match: false,
        why: `order ${rec.orderId.slice(0, 12)} is already ${rec.status}${rec.txid ? ` by ${rec.txid.slice(0, 16)}` : ''}`
      };
    }
    if (rec.engineOnly) return { match: true, via: 'ord-tag', claim: null };
    const claims = await this._payoutClaims(rec);
    if (claims === undefined) return undefined;
    const mine = claims.find((c) => c.txid === id);
    if (mine) {
      if (!this._claimPaysOrder(mine, rec)) {
        return { match: false, why: `stored payout claim for ${rec.orderId.slice(0, 12)} does not match the order` };
      }
      return { match: true, via: 'payout-claim', claim: mine };
    }
    if (rec.txid) {
      return { match: false, why: `order ${rec.orderId.slice(0, 12)} already holds a different signed body ${rec.txid.slice(0, 16)}` };
    }
    const cur = claims.find((c) => c.gen === (rec.resigns || 0));
    if (cur) return { match: false, why: `order ${rec.orderId.slice(0, 12)} was signed as ${cur.txid.slice(0, 16)}, not this tx` };
    return { match: true, via: 'ord-tag', claim: null };
  },

  _applyOrderMatch(rec, txid, { via, claim = null, final = false } = {}) {
    rec.superseded = rec.superseded || [];
    if (rec.txid && rec.txid !== txid) {
      rec.superseded.push({
        txid: rec.txid,
        nonce: rec.nonce,
        error: 'another body of this payout is on the ledger',
        reason: 'LEDGER_ORD_MATCH',
        at: now()
      });
    }
    rec.superseded = (rec.superseded || []).filter((s) => s.txid !== txid);
    rec.txid = txid;
    rec.body = claim && claim.body ? claim.body : null;
    rec.nonce = claim && Number.isInteger(Number(claim.nonce)) ? Number(claim.nonce) : this._txNonce.get(txid) ?? null;
    rec.claimedNonce = null;
    rec.status = final ? 'CONFIRMED' : 'SENT';
    rec.sentAt = rec.sentAt || now();
    if (final) {
      rec.confirmedAt = now();
      rec.confirmedVia = 'ledger';
    }
    rec.matchedFromLedger = { via, at: now() };
    rec.rejection = null;
    rec.nonceRule = null;
    rec.forceRebroadcast = false;
    rec.lastError = null;
    this._ordVerdict.delete(txid);
    if (rec.kind === 'BET_WIN_PAYOUT') this._invalidatePlayTime();
    this._save();
    this.engine.markOutboundSent(rec.orderId, txid, rec.status);
    this._emit('settlement.updated', this._outboundView(rec));
    if (this.logger) {
      this.logger(`payout ${rec.orderId} matched to bank transfer ${txid.slice(0, 16)} on the ledger (${via}); ${rec.status}, never paid again`);
    }
  },

  async _matchLedgerPayouts() {
    this._adoptOutbound();
    const known = this._knownOutTxids();
    let matched = 0;
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) {
      if (!o.ord || known.has(id)) continue;
      const rec = this.state.outbound[Object.keys(this.state.outbound).find((k) => k.slice(0, 12) === o.ord)];
      if (!rec) continue;
      const v = await this._ordVerdictFor(id, o, rec);
      if (v === undefined) {
        this._tickErrors.push(`ord match ${id.slice(0, 12)}: store unavailable`);
        continue;
      }
      if (!v.match) {
        if (this._ordVerdict.get(id) !== false && this.logger) {
          this.logger(`bank transfer ${id.slice(0, 16)} is NOT matched to its order: ${v.why}`);
        }
        this._ordVerdict.set(id, false);
        rec.ordConflict = { txid: id, why: v.why, at: rec.ordConflict?.txid === id ? rec.ordConflict.at : now() };
        continue;
      }
      this._applyOrderMatch(rec, id, { via: v.via, claim: v.claim, final: Boolean(o.final) });
      known.add(id);
      matched += 1;
    }
    for (const rec of Object.values(this.state.outbound)) {
      if ((rec.status !== 'QUEUED' && rec.status !== 'WAITING_FUNDS') || rec.txid) continue;
      if (this._ledgerTagged(rec)) continue;
      const claims = await this._payoutClaims(rec);
      const cur = (claims || []).find((c) => c.gen === (rec.resigns || 0));
      if (!cur || !this._claimPaysOrder(cur, rec)) continue;
      rec.txid = cur.txid;
      rec.body = cur.body;
      rec.nonce = Number(cur.nonce ?? cur.body.nonce);
      rec.claimedNonce = null;
      rec.status = 'SIGNED';
      rec.signedAt = rec.signedAt || now();
      rec.nextAttemptAt = 0;
      rec.recoveredFromClaim = { at: now() };
      this._save();
      if (this.logger) {
        this.logger(`payout ${rec.orderId} resumes with its stored signed body ${cur.txid.slice(0, 16)} (an earlier pass was cut off before saving it)`);
      }
    }
    return matched;
  },

  _ledgerTagged(rec) {
    const tag = String(rec.orderId).slice(0, 12);
    return Object.values(this.state.ledgerOut || {}).some((o) => o.ord === tag);
  },

  async _explainByOrder(doc, t, recentMemos) {
    const open = Object.values(doc?.outbound || {}).filter(
      (r) => r && r.orderId && !TERMINAL_OUT.has(r.status) && r.txid !== t.id
    );
    if (!open.length) return null;
    const asRec = (r) => ({ ...r, superseded: r.superseded || [] });
    for (const r of open) {
      const rec = asRec(r);
      const claims = await this._payoutClaims(rec);
      if (claims === undefined) return undefined;
      const c = claims.find((x) => x.txid === t.id);
      if (c && this._claimPaysOrder(c, rec) && t.to === rec.to && toMicros(String(t.amount)) === toMicros(String(rec.amountPoa))) {
        return { orderId: rec.orderId, via: 'payout-claim', claim: c };
      }
    }
    let memo = t.memoKnown && typeof t.memo === 'string' ? t.memo : (await recentMemos()).get(t.id);
    if (memo === undefined) {
      try {
        memo = await this.client.getMemo(t.id);
      } catch {
        return undefined;
      }
    }
    const m = /:ord=([0-9a-f]{12})/.exec(String(memo || ''));
    if (!m) return null;
    const r = open.find((x) => String(x.orderId).slice(0, 12) === m[1]);
    if (!r) return null;
    const v = await this._ordVerdictFor(t.id, { to: t.to, amountPoa: t.amount }, asRec(r));
    if (v === undefined) return undefined;
    return v.match ? { orderId: r.orderId, via: v.via, claim: v.claim } : null;
  },

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
      return {
        txid: id,
        adopt: same,
        why: same ? 'identical payout already on the ledger' : `different payout on the ledger (${o.amountPoa} POA to ${o.to})`
      };
    }
    return null;
  },

  async _receipt(txid) {
    const r = await this.client.getReceipt(txid).catch(() => undefined);
    if (r === undefined || r === null) return r;
    if (typeof r !== 'object' || !r.status) return undefined;
    return r;
  },

  async _sentBody(rec) {
    const ok = (b) =>
      b &&
      txidOf(b) === rec.txid &&
      b.from === this.bankAddress &&
      b.to === rec.to &&
      toMicros(String(b.amount)) === toMicros(rec.amountPoa) &&
      (!Number.isInteger(rec.nonce) || Number(b.nonce) === rec.nonce);
    if (ok(rec.body)) return rec.body;
    if (typeof this.store.peek !== 'function') return null;
    try {
      const v = await this.store.peek(`payout:${rec.orderId}:${rec.resigns || 0}`);
      if (v && v.txid === rec.txid && ok(v.body)) return v.body;
    } catch {
      // store unavailable: no proof this tick
    }
    return null;
  },

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
  },

  async _nonceFromReceipts() {
    let best = null;
    const bump = (n) => {
      if (Number.isInteger(n) && n > 0 && (best === null || n > best)) best = n;
    };
    for (const o of Object.values(this.state.outbound)) {
      if (o.repayment?.status === 'HELD' || o.status === 'REJECTED') continue;
      if (!Number.isInteger(o.nonce) || !o.txid) continue;
      if (o.status === 'CONFIRMED') bump(o.nonce + 1);
      else if (o.status === 'SENT') {
        const r = await this._receipt(o.txid);
        if (r && r.txid === o.txid && ['included', 'final', 'confirmed'].includes(String(r.status).toLowerCase())) {
          bump(o.nonce + 1);
          bump(Number(r.next_nonce));
        }
      }
    }
    const rejectedTx = new Set();
    for (const o of Object.values(this.state.outbound)) {
      if ((o.status === 'REJECTED' || o.repayment?.status === 'HELD') && o.txid) rejectedTx.add(o.txid);
    }
    for (const [id, n] of this._txNonce) {
      if (rejectedTx.has(id)) continue;
      bump(n + 1);
    }
    return best;
  },

  async _nonceOfTx(txid) {
    if (this._txNonce.has(txid)) return this._txNonce.get(txid);
    const tx = await this.client.getTx(txid);
    if (!tx || tx.invalid) return null;
    const n = Number(tx.body?.nonce);
    if (!Number.isInteger(n) || (tx.from && tx.from !== this.bankAddress)) return null;
    this._txNonce.set(txid, n);
    return n;
  },

  async _chainNextNonce() {
    const row = await this.client.getAddress(this.bankAddress);
    const sent = (row.txs || [])
      .filter((t) => t && t.id && t.from === this.bankAddress)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, this.nonceScanDepth);
    let max = 0;
    for (const t of sent) {
      const n = await this._nonceOfTx(t.id);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return max + 1;
  },

  _nonceReservedByRejected(orderId) {
    if (!orderId) return false;
    const o = this.state.outbound[orderId];
    return Boolean(o && (o.status === 'REJECTED' || o.status === 'DISMISSED' || o.repayment?.status === 'HELD'));
  },

  /** Drop bank-nonce claims held by REJECTED or HELD repayments. Does not change those payout records. */
  async _releaseRejectedNonceHolds() {
    let claims = [];
    try {
      claims = await this._persist.listClaims('bank-nonce:');
    } catch {
      return;
    }
    for (const c of claims || []) {
      if (this._nonceReservedByRejected(c.value?.orderId)) await this._persist.deleteClaim(c.key).catch(() => {});
    }
  },

  async _releaseNonceClaim(nonce, orderId) {
    if (!Number.isInteger(Number(nonce))) return;
    const key = `bank-nonce:${Number(nonce)}`;
    try {
      let hit = null;
      if (typeof this.store?.peek === 'function') {
        hit = await this.store.peek(key);
      } else {
        const claims = await this._persist.listClaims(key);
        hit = (claims || []).find((c) => c.key === key)?.value || null;
      }
      if (!hit) return;
      if (orderId && hit.orderId && hit.orderId !== orderId) return;
      await this._persist.deleteClaim(key);
    } catch {
      // a busy store retries on the next tick; the nonce is not advanced
    }
  },

  async _claimExactNonce(rec, n) {
    await this._releaseRejectedNonceHolds();
    const key = `bank-nonce:${n}`;
    let res = await this._persist.claim(key, { orderId: rec.orderId, gen: rec.resigns || 0, at: now() });
    if (!res.claimed && this._nonceReservedByRejected(res.value?.orderId)) {
      await this._persist.deleteClaim(key).catch(() => {});
      res = await this._persist.claim(key, { orderId: rec.orderId, gen: rec.resigns || 0, at: now() });
    }
    if (res.claimed || res.value?.orderId === rec.orderId) return n;
    throw Object.assign(new Error(`nonce ${n} is reserved by an in-flight payout; retrying the same payout`), { busy: true });
  },

  _confirmedNonceFloor() {
    let floor = 0;
    for (const o of Object.values(this.state.outbound)) {
      if (o.repayment?.status === 'HELD' || o.status === 'REJECTED' || o.status === 'DISMISSED') continue;
      if (o.status === 'CONFIRMED' && Number.isInteger(o.nonce)) floor = Math.max(floor, o.nonce + 1);
      if (
        o.status === 'SENT' &&
        o.receipt &&
        /^(included|final|confirmed)$/i.test(String(o.receipt.status || ''))
      ) {
        if (Number.isInteger(o.nonce)) floor = Math.max(floor, o.nonce + 1);
        const rn = Number(o.receipt.next_nonce);
        if (Number.isInteger(rn) && rn > 0) floor = Math.max(floor, rn);
      }
    }
    return floor;
  },

  async _chooseBankNonce(rec) {
    const rule = rec.nonceRule || {};
    if (Number.isInteger(rule.fixed)) return this._claimExactNonce(rec, rule.fixed);
    let chainNext;
    try {
      chainNext = await this.client.nextNonce(this.bankAddress);
    } catch (err) {
      if (!isLedgerBusy(err)) throw err;
      const fromReceipts = await this._nonceFromReceipts().catch(() => null);
      if (fromReceipts === null) throw Object.assign(new Error(`chain next nonce unavailable (${err.message})`), { busy: true, retryAfterMs: err.retryAfterMs });
      chainNext = fromReceipts;
    }
    const floor = Number.isInteger(rule.floor) ? rule.floor : 0;
    const n = Math.max(chainNext, this._confirmedNonceFloor(), floor);
    return this._claimExactNonce(rec, n);
  },

  async _landedSuperseded(rec) {
    for (const s of rec.superseded || []) {
      if (!s.txid) continue;
      const tx = await this.client.getTx(s.txid).catch(() => undefined);
      if (tx === undefined) return undefined;
      if (tx && !tx.invalid) return s.txid;
    }
    return null;
  },

  _adoptLanded(rec, txid) {
    if (rec.txid && rec.txid !== txid) {
      rec.superseded.push({
        txid: rec.txid,
        nonce: rec.nonce,
        error: 'an earlier body of this payout landed instead',
        reason: 'EARLIER_BODY_LANDED',
        at: now()
      });
    }
    rec.superseded = rec.superseded.filter((s) => s.txid !== txid);
    rec.txid = txid;
    rec.nonce = this._txNonce.get(txid) ?? null;
    rec.claimedNonce = null;
    rec.body = null;
    rec.status = 'SENT';
    rec.sentAt = now();
    rec.rejection = null;
    rec.nonceRule = null;
    rec.lastError = null;
    this._save();
    this.engine.markOutboundSent(rec.orderId, rec.txid, 'SENT');
    this._emit('settlement.updated', this._outboundView(rec));
  },

  async _nonceConsumer(nonce, excludeTxid) {
    const ids = new Set(Object.keys(this.state.ledgerOut || {}));
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
      if (this._txNonce.has(id) && this._txNonce.get(id) !== nonce) continue;
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
  },

  async _reconcilePayouts(recs) {
    if (this.ledgerProbe && this.ledgerProbe.hold()) return;
    for (const rec of recs) {
      if (!rec.txid || rec.recoveredFromLedger) continue;
      if (rec.status === 'SENT') {
        if (now() - (rec.sentAt || 0) < this.sentGraceMs) continue;
        if (rec.nextReceiptCheckAt && now() < rec.nextReceiptCheckAt) continue;
        rec.nextReceiptCheckAt = now() + this.rejectCheckIntervalMs;
        const receipt = await this._receipt(rec.txid);
        if (isRejectedReceipt(receipt)) {
          const stale = now() - (rec.sentAt || 0) > this.stuckAfterMs;
          this._markRejected(rec, String(receipt.error || receipt.status || 'rejected'), 'receipt');
          await this._releaseNonceClaim(rec.nonce, rec.orderId);
          if (stale) this._holdRepayment(rec, receipt);
          continue;
        }
        await this._maybeRebroadcast(rec, receipt);
        continue;
      }
      if (rec.status === 'REJECTED') {
        if (rec.repayment?.status === 'HELD') continue;
        await this._checkRejected(rec);
      }
    }
  },

  async _maybeRebroadcast(rec, receipt) {
    if (!rec.body || rec.recoveredFromLedger || txidOf(rec.body) !== rec.txid) return false;
    const staleReceipt = Boolean(receipt && rec.receipt && now() - (rec.sentAt || 0) > this.stuckAfterMs);
    if (receipt !== null && !staleReceipt) return false;
    if (now() - (rec.lastBroadcastAt || rec.sentAt || 0) < this.rebroadcastAfterMs) return false;
    if (rec.nextRebroadcastAt && now() < rec.nextRebroadcastAt) return false;
    const seen = await this.client.getTx(rec.txid).catch(() => undefined);
    if (seen !== null) return false;
    rec.rebroadcasts = (rec.rebroadcasts || 0) + 1;
    rec.lastBroadcastAt = now();
    try {
      await this.client.submitTx(rec.body);
      rec.lastError = null;
      if (this.logger) this.logger(`payout ${rec.orderId} rebroadcast (same body ${rec.txid.slice(0, 16)}, nonce ${rec.nonce})`);
    } catch (err) {
      rec.lastError = `rebroadcast: ${String(err.message || err).slice(0, 160)}`;
      rec.nextRebroadcastAt = this._payoutRetryAt(rec.rebroadcasts, err);
      this.ledgerProbe?.reportFailure('payout rebroadcast', err);
    }
    this._save();
    this._emit('settlement.updated', this._outboundView(rec));
    return true;
  },

  async _checkRejected(rec) {
    const r =
      rec.rejection ||
      (rec.rejection = {
        txid: rec.txid,
        nonce: rec.nonce,
        error: 'rejected',
        source: 'unknown',
        expected: null,
        kind: null,
        firstAt: now(),
        lastCheckAt: 0,
        checks: 0,
        consumedBy: null,
        lastTransient: null
      });
    if (r.checks > 0 && now() - r.lastCheckAt < this.rejectCheckIntervalMs) return;
    r.lastCheckAt = now();
    const transient = (why) => {
      r.checks = 0;
      r.lastTransient = why;
      this._save();
    };
    const tx = await this.client.getTx(rec.txid).catch(() => undefined);
    if (tx === undefined) return transient('explorer could not answer for the rejected txid');
    if (tx && !tx.invalid) return this._adoptLanded(rec, rec.txid);
    const landed = await this._landedSuperseded(rec);
    if (landed === undefined) return transient('explorer could not answer for an earlier body');
    if (landed) return this._adoptLanded(rec, landed);
    const receipt = await this._receipt(rec.txid);
    if (receipt === undefined) return transient('receipt unavailable');
    if (receipt && !isRejectedReceipt(receipt)) {
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
  },

  _resign(rec, rule) {
    const r = rec.rejection || {};
    rec.superseded.push({
      txid: rec.txid,
      nonce: rec.nonce,
      error: r.error || rec.lastError,
      reason: r.kind || 'REJECTED',
      consumedBy: r.consumedBy || null,
      rejectedAt: r.firstAt || now(),
      at: now()
    });
    rec.resigns = (rec.resigns || 0) + 1;
    rec.nonceRule = rule;
    rec.txid = null;
    rec.body = null;
    rec.nonce = null;
    rec.claimedNonce = null;
    rec.rejection = null;
    rec.forceRebroadcast = false;
    this._tip = null;
    rec.status = rec.resigns > this.maxResign ? 'FAILED' : 'QUEUED';
    rec.nextAttemptAt = 0;
    if (rec.status === 'FAILED') {
      rec.lastError = `payout rejected ${rec.resigns} times; operator must review`;
      this._failEngine(rec);
    }
    if (this.logger) {
      this.logger(`payout ${rec.orderId} re-signing (${rule.fixed !== undefined ? `same nonce ${rule.fixed}` : `nonce >= ${rule.floor}`})`);
    }
    this._save();
    this._emit('settlement.updated', this._outboundView(rec));
  },

  _holdRepayment(rec, receipt) {
    if (rec.repayment?.status === 'HELD') return;
    const reason = String(receipt?.error || receipt?.status || rec.rejection?.error || 'rejected');
    rec.repayment = {
      status: 'HELD',
      orderId: rec.orderId,
      amountPoa: rec.amountPoa,
      txid: rec.txid,
      nonce: rec.nonce ?? null,
      reason,
      code: /bad[_\s-]*nonce/i.test(reason) ? 'bad_nonce' : null,
      heldAt: now(),
      approved: false
    };
    rec.lastError = `repayment held for approval: ${reason}`;
    this._save();
    this._emit('settlement.updated', this._outboundView(rec));
  },

  repaymentQueueView() {
    let total = 0n;
    const items = [];
    for (const o of Object.values(this.state.outbound)) {
      if (o.repayment?.status !== 'HELD') continue;
      total += toMicros(o.amountPoa);
      items.push({
        orderId: o.orderId,
        kind: o.kind || null,
        to: o.to || null,
        amountPoa: o.amountPoa,
        txid: o.txid || null,
        nonce: o.nonce ?? null,
        sourceTxid: o.sourceTxid || null,
        reason: o.repayment.reason || null,
        code: o.repayment.code || null,
        heldAt: o.repayment.heldAt ? new Date(o.repayment.heldAt).toISOString() : null
      });
    }
    return { status: 'HELD', count: items.length, totalPoa: fromMicros(total), awaitingApproval: true, items };
  },

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
        receiptOnly: o.status === 'SENT' && Boolean(o.receipt),
        txid: o.txid,
        nonce: o.nonce,
        error: o.rejection?.error || o.lastError || null,
        kind: o.rejection?.kind || null,
        rejectionChecks: o.rejection?.checks ?? null,
        since: (() => {
          const ts = o.rejection?.firstAt || o.sentAt || o.repayment?.heldAt || o.createdAt;
          return ts ? new Date(ts).toISOString() : null;
        })(),
        superseded: o.superseded || []
      });
    }
    return out;
  },

  _outboundView(rec) {
    return {
      direction: 'outbound',
      orderId: rec.orderId,
      kind: rec.kind,
      sourceTxid: rec.sourceTxid,
      to: rec.to,
      amountPoa: rec.amountPoa,
      status:
        rec.status === 'QUEUED' || rec.status === 'WAITING_FUNDS' || rec.status === 'SIGNED' || rec.status === 'REJECTED'
          ? 'PENDING'
          : rec.status,
      rawStatus: rec.status,
      txid: rec.txid,
      explorer: rec.txid ? this.client.explorerTxUrl(rec.txid) : null,
      attempts: rec.attempts,
      lastError: rec.lastError,
      rejection: rec.rejection
        ? {
            error: rec.rejection.error,
            kind: rec.rejection.kind,
            expectedNonce: rec.rejection.expected,
            checks: rec.rejection.checks
          }
        : null,
      superseded: rec.superseded
    };
  }
};
