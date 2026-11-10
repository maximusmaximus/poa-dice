// @ts-nocheck
/**
 * settlement/coverage-manager.mjs — Bankroll solvency & cross-instance bet coverage reservations.
 */
import { fromMicros, toMicros } from '../crypto-poa.mjs';
import { OPEN_IN, STANDBY_STATUS_REFRESH_MS, TERMINAL_OUT, now } from './constants.mjs';

export const coverageManagerMethods = {
  coverageLimit() {
    const hold = this.tradingHold();
    if (hold) return { known: false, code: hold.status, reason: hold.reason };
    if (!this.writer.canWrite() && this.writer.status === 'STANDBY') {
      const c = this.shared?.coverage;
      if (!c || !c.known) {
        return {
          known: false,
          code: c?.code || 'BANK_BALANCE_UNKNOWN',
          reason: c?.reason || "The bank writer has not published the bank's free funds yet; bets are paused."
        };
      }
      const limit = BigInt(c.limitMicros);
      return { known: true, limitMicros: limit, baseMicros: limit, source: 'writer-status' };
    }
    const row = this._lastRow;
    if (!row || typeof row.effectiveMicros !== 'bigint') {
      return {
        known: false,
        code: 'BANK_BALANCE_UNKNOWN',
        reason: 'The bank balance on minepoa is unknown right now; bets are paused until it can be read.'
      };
    }
    if (now() - this._lastRowAt > this.balanceStaleMs) {
      return {
        known: false,
        code: 'BANK_BALANCE_STALE',
        reason: `The bank balance was last read ${Math.round((now() - this._lastRowAt) / 1000)}s ago; bets are paused until it is refreshed.`
      };
    }
    let pendingOut = 0n;
    for (const o of Object.values(this.state.outbound)) {
      if (!TERMINAL_OUT.has(o.status) && o.status !== 'SENT' && o.status !== 'SIGNED') pendingOut += toMicros(o.amountPoa);
    }
    for (const item of this.engine.outboundQueue) {
      if (item.status === 'PENDING' && !this.state.outbound[item.orderId]) pendingOut += BigInt(item.amountMicros);
    }
    const onChainFree =
      row.effectiveMicros -
      this._inFlightOutMicros(row.listedIds) -
      pendingOut -
      this.engine.devReserveMicros -
      this.engine.incentivePoolMicros;
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
    return {
      known: true,
      limitMicros: limit > 0n ? limit : 0n,
      baseMicros: base,
      onChainFreeMicros: onChainFree,
      navMicros: nav,
      withdrawalLiabilityMicros: withdrawLiab
    };
  },

  async ensureFreshBalance() {
    if (this.writer.status === 'STANDBY') {
      if (now() - this._sharedReadAt > STANDBY_STATUS_REFRESH_MS) {
        await (this.passMode ? this._observe() : this.tick()).catch(() => {});
      }
      return;
    }
    if (!this._lastRow || now() - this._lastRowAt > this.balanceStaleMs || !this.reconcile.at) {
      await this.tick().catch(() => {});
    }
  },

  async betCoverage(worstMicros, { reserveKey = null } = {}) {
    const lim = this.coverageLimit();
    if (!lim.known) return { ok: false, unknown: true, code: lim.code, reason: lim.reason };
    const w = BigInt(worstMicros);
    let used;
    if (reserveKey) {
      let r;
      try {
        r = await this._persist.reserveCapacity(
          'bets',
          reserveKey,
          w.toString(),
          lim.limitMicros.toString(),
          this.inboundExpireMs + 5 * 60 * 1000
        );
      } catch (err) {
        return {
          ok: false,
          unknown: true,
          code: 'COVERAGE_STORE_ERROR',
          reason: `Could not reserve bank coverage (${err.message}); bets are paused.`
        };
      }
      used = BigInt(r.usedMicros);
      if (r.ok) {
        return {
          ok: true,
          reserved: true,
          limitMicros: lim.limitMicros,
          usedMicros: used,
          freeMicros: lim.limitMicros - used,
          worstMicros: w
        };
      }
    } else {
      try {
        used = BigInt(await this._persist.capacityUsed('bets'));
      } catch (err) {
        return {
          ok: false,
          unknown: true,
          code: 'COVERAGE_STORE_ERROR',
          reason: `Could not read bank coverage (${err.message}); bets are paused.`
        };
      }
      if (used + w <= lim.limitMicros) {
        return {
          ok: true,
          limitMicros: lim.limitMicros,
          usedMicros: used,
          freeMicros: lim.limitMicros - used,
          worstMicros: w
        };
      }
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
  },

  async reserveBetCoverage(key, worstMicros) {
    await this.ensureFreshBalance();
    const cov = await this.betCoverage(worstMicros, { reserveKey: key });
    if (!cov.ok) {
      throw Object.assign(new Error(`${cov.reason} Not broadcast.`), {
        status: cov.unknown ? 503 : 409,
        code: cov.code,
        coverage: cov
      });
    }
    return cov;
  },

  releaseBetCoverage(key, micros = null) {
    return this._persist
      .releaseCapacity('bets', key, micros === null ? null : String(micros))
      .catch((err) => this._tickErrors.push(`coverage release: ${err.message}`));
  },

  _releaseCoverage(rec) {
    if (!rec || !rec.coverage) return false;
    const { key, micros } = rec.coverage;
    rec.coverage = null;
    this.releaseBetCoverage(key, key === rec.txid ? null : micros);
    return true;
  }
};
