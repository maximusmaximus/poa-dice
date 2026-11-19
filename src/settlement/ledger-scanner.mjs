// @ts-nocheck
/**
 * settlement/ledger-scanner.mjs — Bank explorer scanning, incremental POAScan backfill
 * (including missed inbound DICE1: discovery), and trusted balance fallback.
 */
import { fromMicros, parseDiceMemo, toMicros } from '../crypto-poa.mjs';
import { isLedgerBusy } from '../ledger-probe.mjs';
import { bankHistoryOf, bankHistoryTotals, mergeBankTxs, poascanHistoryProblem } from '../bank-history.mjs';
import { now } from './constants.mjs';

export const ledgerScannerMethods = {
  async _scanBank() {
    let row;
    try {
      row = await this.client.getAddress(this.bankAddress);
    } catch (err) {
      this._tickErrors.push(err.message);
      const trusted = isLedgerBusy(err) ? this._trustedRow() : null;
      if (trusted) {
        this._lastRow = trusted;
        this._lastRowAt = now();
        this._balanceRow = trusted;
        this.ledgerIndexComplete = true;
        return trusted;
      }
      this._lastRow = null;
      return null;
    }
    let recent = null;
    try {
      recent = await this.client.getRecentTransfers(200);
    } catch {
      recent = null;
    }

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
        if (this._isCompactedInbound(t.id, t.ts)) continue;
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
        if (memo === null || !String(memo).startsWith('DICE1:')) continue;
        let accepted = null;
        try {
          accepted = await this._acceptedClaim(t, memo);
        } catch (err) {
          this._tickErrors.push(`acceptance ${t.id.slice(0, 12)}: ${err.message}`);
          continue;
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
        this.state.ledgerOut[t.id] = {
          ord: m ? m[1] : null,
          to: t.to,
          amountPoa: t.amount,
          memo: String(memo).slice(0, 200),
          final: Boolean(t.final),
          ts: t.ts || null
        };
        this._save();
      }
    }

    const history = await this._syncBankHistory(row.txs || [], txs);
    if (!history.complete) outIndexComplete = false;
    this.ledgerIndexComplete = outIndexComplete;

    let checkpointMicros = null;
    try {
      checkpointMicros = toMicros(row.balance || '0');
    } catch {
      checkpointMicros = null;
    }
    const totals = bankHistoryTotals(bankHistoryOf(this.state));
    const listed = totals.ids;
    const finalIn = totals.finalIn;
    const outAll = totals.outAll;
    const est1 = finalIn - outAll;
    const est2 = checkpointMicros === null ? null : checkpointMicros - outAll;
    const effective = est2 === null ? est1 : est1 > est2 ? est1 : est2;
    row.effectiveMicros = effective;
    row.listedIds = listed;
    row.historyComplete = history.complete;
    row.historyReason = history.reason;
    this.lastBankBalance = {
      balance: fromMicros(effective < 0n ? 0n : effective),
      checkpointBalance: row.balance,
      checkpointHeight: row.checkpoint == null ? null : Number(row.checkpoint),
      ledgerFinalInPoa: fromMicros(finalIn),
      ledgerOutPoa: fromMicros(outAll),
      source: est2 !== null && est2 >= est1 ? 'checkpoint-minus-outbound' : 'ledger-history-final',
      historyTxs: totals.count,
      minepoaListed: (row.txs || []).length,
      historyComplete: history.complete,
      ...(history.complete ? {} : { historyProblem: history.reason }),
      at: now()
    };
    this._lastRow = outIndexComplete ? row : null;
    this._lastRowAt = now();
    this._balanceRow = row;
    if (outIndexComplete) this._noteTrustedRow(row, txs);
    return row;
  },

  async _syncBankHistory(listing, txs) {
    const hist = bankHistoryOf(this.state);
    const before = new Set(Object.keys(hist.txs));
    for (const id of hist.recentCompactedIds || []) before.add(id);
    const hotBefore = new Set(Object.keys(hist.txs));
    const capped = listing.length >= this.addressListCap;
    const overlap = listing.some((t) => t && t.id && before.has(String(t.id).toLowerCase()));
    const wasComplete = hist.complete;
    const merged = mergeBankTxs(hist, txs, this.bankAddress, 'minepoa');
    let complete = false;
    let reason = null;
    let via = null;
    if (merged.conflicts.length) {
      reason = `minepoa lists transfer(s) ${merged.conflicts.map((id) => id.slice(0, 16)).join(', ')} with a different amount or direction than the recorded bank history`;
    } else if (!capped) {
      complete = true;
      via = 'minepoa-full-list';
    } else if (hist.complete && overlap) {
      complete = true;
      via = hist.completeVia;
    } else {
      const r = await this._backfillBankHistory(hist, listing, { wasComplete, hotBefore });
      complete = r.ok;
      reason = r.reason;
      via = 'poascan';
    }
    let dirty = merged.added > 0 || merged.changed > 0 || Boolean(this._backfillDirtied);
    this._backfillDirtied = false;
    if (complete && (!hist.complete || hist.completeVia !== via)) {
      hist.complete = true;
      hist.completeAt = now();
      hist.completeVia = via;
      dirty = true;
    } else if (!complete && hist.complete) {
      hist.complete = false;
      dirty = true;
    }
    if (dirty) this._save();
    if (wasComplete !== complete && this.logger) {
      this.logger(
        `bank history: ${complete ? `complete (${via}, ${bankHistoryTotals(hist).count} txs)` : `NOT complete: ${reason}`}`
      );
    }
    this._historyStatus = { complete, reason, via: complete ? via : null, minepoaListed: listing.length, capped, at: now() };
    return { complete, reason };
  },

  _isCompactedInbound(txid, ts, priorCompactedIds = null) {
    if (!txid) return false;
    const recentIn = this.state.compacted?.recentInboundIds;
    if (Array.isArray(recentIn) && recentIn.includes(txid)) return true;
    const histCompacted = this.state.bankHistory?.recentCompactedIds;
    if (Array.isArray(histCompacted) && histCompacted.includes(txid)) return true;
    if (priorCompactedIds && priorCompactedIds.has(txid)) return true;
    const throughTs = Number(this.state.compacted?.inboundThroughTs || 0);
    if (throughTs > 0 && Number(ts || 0) > 0 && Number(ts) < throughTs) return true;
    return false;
  },

  async _backfillBankHistory(hist = bankHistoryOf(this.state), listing = [], { wasComplete = false, hotBefore = new Set() } = {}) {
    const ix = this.indexer;
    const st = this._historyBackfill;
    if (!ix || typeof ix.addressTxs !== 'function') {
      st.reason = `minepoa lists only the bank's newest ${this.addressListCap} transfers and no independent index (POAScan) is configured to read the older ones`;
      return { ok: false, reason: st.reason };
    }
    if (st.at && now() - st.at < this.historyBackfillEveryMs) {
      return { ok: false, reason: st.reason || 'waiting to read the bank history from POAScan again' };
    }
    st.at = now();
    const src = ix.name || 'POAScan';
    let rows;
    try {
      const canStopIncrementally = Boolean(wasComplete && hotBefore.size > 0);
      rows = await ix.addressTxs(this.bankAddress, {
        stopWhen: canStopIncrementally
          ? (pageRows) => pageRows.some((r) => r && r.id && hotBefore.has(String(r.id).toLowerCase()))
          : null
      });
    } catch (err) {
      st.reason = `${src} could not supply the bank's full history (${String(err?.message || err).slice(0, 120)}); transfers older than minepoa's newest ${this.addressListCap} cannot be verified`;
      this._tickErrors.push(`bank history: ${st.reason}`);
      return { ok: false, reason: st.reason };
    }
    const problem = poascanHistoryProblem(rows, listing, this.bankAddress);
    if (problem) {
      st.reason = `${src} bank history not usable: ${problem}`;
      this._tickErrors.push(`bank history: ${st.reason}`);
      return { ok: false, reason: st.reason };
    }
    const finalRows = rows.filter((t) => t && t.final);
    const ownMismatch = [];
    const ownOut = new Map();
    for (const o of Object.values(this.state.outbound)) {
      if (o.txid) ownOut.set(o.txid, o.amountPoa);
      for (const x of o.superseded || []) if (x.txid && x.amountPoa) ownOut.set(x.txid, o.amountPoa);
    }
    for (const [id, o] of Object.entries(this.state.ledgerOut || {})) if (!ownOut.has(id)) ownOut.set(id, o.amountPoa);
    for (const t of finalRows) {
      let mine = null;
      let dir = null;
      if (ownOut.has(t.id)) [mine, dir] = [ownOut.get(t.id), 'out'];
      else if (this.state.inbound[t.id]) [mine, dir] = [this.state.inbound[t.id].amountPoa, 'in'];
      if (mine === null || mine === undefined) continue;
      const theirs = t.to === this.bankAddress ? 'in' : t.from === this.bankAddress ? 'out' : null;
      let same = theirs === dir;
      try {
        same = same && toMicros(mine) === toMicros(t.amount || '0');
      } catch {
        same = false;
      }
      if (!same) ownMismatch.push(t.id);
    }
    if (ownMismatch.length) {
      st.reason = `${src} and this vault's own records disagree on transfer(s) ${ownMismatch.map((id) => id.slice(0, 16)).join(', ')} (amount or direction)`;
      this._tickErrors.push(`bank history: ${st.reason}`);
      return { ok: false, reason: st.reason };
    }

    // Snapshot compaction guardsets BEFORE resetting hist.checkpoint on a full genesis-to-tip read,
    // so historical LP_ADD / BET txs already processed & compacted are NEVER re-booked as new inbound.
    const priorCompactedIds = new Set(hist.recentCompactedIds || []);

    // If a full genesis-to-tip read ran while older txs were compacted into hist.checkpoint,
    // reset checkpoint first so full finalRows are never double-counted against folded totals.
    if (!rows.partial && Number(hist.checkpoint?.count || 0) > 0) {
      const unfinalizedOnly = {};
      for (const [id, e] of Object.entries(hist.txs || {})) {
        if (!e.f) unfinalizedOnly[id] = e;
      }
      hist.txs = unfinalizedOnly;
      hist.checkpoint = { finalInMicros: '0', outAllMicros: '0', count: 0 };
      hist.recentCompactedIds = [];
    }

    const merged = mergeBankTxs(hist, finalRows, this.bankAddress, 'poascan');
    if (merged.conflicts.length) {
      st.reason = `${src} and minepoa disagree on transfer(s) ${merged.conflicts.map((id) => id.slice(0, 16)).join(', ')} (amount or direction)`;
      this._tickErrors.push(`bank history: ${st.reason}`);
      return { ok: false, reason: st.reason };
    }

    // Index both missed bank outflows (ledgerOut) AND missed finalized inbound DICE1: transfers (oldest-first)
    const chronological = [...finalRows].sort(
      (a, b) => (a.checkpointHeight ?? 0) - (b.checkpointHeight ?? 0) || (a.ts || 0) - (b.ts || 0)
    );
    for (const t of chronological) {
      if (t.from === this.bankAddress && t.to !== this.bankAddress) {
        if (this.state.ledgerOut[t.id] || t.memo === null || t.memo === undefined) continue;
        const m = /:ord=([0-9a-f]{12})/.exec(String(t.memo));
        this.state.ledgerOut[t.id] = {
          ord: m ? m[1] : null,
          to: t.to,
          amountPoa: t.amount,
          memo: String(t.memo).slice(0, 200),
          final: true,
          ts: t.ts || null,
          via: 'poascan'
        };
        this._backfillDirtied = true;
      } else if (t.to === this.bankAddress && t.from !== this.bankAddress) {
        if (this.state.inbound[t.id] || this.engine.processedTxids.has(t.id)) continue;
        if (this._isCompactedInbound(t.id, t.ts, priorCompactedIds)) continue;
        let memo = t.memo !== undefined && t.memo !== null ? String(t.memo) : undefined;
        if (memo === undefined) {
          try {
            memo = await this.client.getMemo(t.id);
          } catch {
            memo = undefined;
          }
        }
        if (!memo || !String(memo).startsWith('DICE1:')) continue;
        const accepted = await this._acceptedClaim(t, memo).catch(() => null);
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
          via: 'poascan',
          reserve: null,
          groupId: null,
          attempts: 0,
          error: null,
          result: null,
          ledger: { atts: Number(t.atts || 5), final: true }
        };
        if (accepted) Object.assign(this.state.inbound[t.id], accepted);
        this._backfillDirtied = true;
      }
    }

    st.reason = null;
    st.okAt = now();
    st.added = merged.added;
    if (this.logger) {
      this.logger(`bank history: backfilled ${merged.added} older transfer(s) from ${src} (${rows.length} listed there)`);
    }
    return { ok: true, reason: null };
  },

  bankHistoryView() {
    const hist = bankHistoryOf(this.state);
    const totals = bankHistoryTotals(hist);
    const st = this._historyStatus;
    return {
      complete: Boolean(st ? st.complete : hist.complete),
      txs: totals.count,
      hotTxs: Object.keys(hist.txs).length,
      checkpointedTxs: Number(hist.checkpoint?.count || 0),
      via: hist.completeVia || null,
      completeAt: hist.completeAt ? new Date(hist.completeAt).toISOString() : null,
      minepoaListed: st?.minepoaListed ?? null,
      minepoaCap: this.addressListCap,
      problem: st && !st.complete ? st.reason : null,
      lastPoascanBackfillAt: this._historyBackfill.okAt ? new Date(this._historyBackfill.okAt).toISOString() : null
    };
  },

  _noteTrustedRow(row, txs) {
    const outIds = txs.filter((t) => t.from === this.bankAddress && t.to !== this.bankAddress).map((t) => t.id);
    const prev = this.state.trustedBank;
    const eff = String(row.effectiveMicros);
    const changed = !prev || prev.effectiveMicros !== eff || (prev.listedOutIds || []).length !== outIds.length;
    if (!changed && now() - Number(prev.at || 0) < 60000) return;
    this.state.trustedBank = {
      effectiveMicros: eff,
      listedOutIds: outIds,
      checkpointBalance: row.balance ?? null,
      checkpoint: row.checkpoint ?? null,
      at: now()
    };
    this._save();
  },

  _trustedRow() {
    const tb = this.state.trustedBank;
    if (!tb || !tb.effectiveMicros) return null;
    const rawAge = now() - Number(tb.at || 0);
    if (!(rawAge >= -5000 && rawAge <= this.trustedBalanceMaxAgeMs)) return null;
    const age = Math.max(0, rawAge);
    let eff;
    try {
      eff = BigInt(tb.effectiveMicros);
    } catch {
      return null;
    }
    const listedIds = new Set(tb.listedOutIds || []);
    const hist = bankHistoryOf(this.state);
    for (const id of Object.keys(hist.txs)) listedIds.add(id);
    for (const id of hist.recentCompactedIds || []) listedIds.add(id);
    const row = {
      address: this.bankAddress,
      balance: tb.checkpointBalance,
      checkpoint: tb.checkpoint,
      txs: [],
      effectiveMicros: eff,
      listedIds,
      fromTrusted: true,
      trustedAt: Number(tb.at),
      historyComplete: true
    };
    this.lastBankBalance = {
      ...(this.lastBankBalance || {}),
      balance: fromMicros(eff < 0n ? 0n : eff),
      source: 'last-trusted-read',
      trustedAt: new Date(Number(tb.at)).toISOString(),
      trustedAgeMs: age,
      at: now()
    };
    return row;
  },

  _scanBankReadOnly() {
    return this._scanBank();
  },

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
      note: memo.startsWith('DICE1:')
        ? 'Found on the minepoa ledger. The vault books it on its next scan (idempotent by txid).'
        : 'Transfer to the bank without a DICE1 memo; not a game action.'
    };
  }
};
