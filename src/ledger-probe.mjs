// @ts-nocheck
/**
 * minepoa writability probe → LEDGER_UNAVAILABLE trading hold.
 *
 * Payouts need two things from minepoa: GET /api/txs (tip parents for every new tx) and
 * POST /api/submit (broadcast). The probe checks exactly those, with no key:
 *   - GET  /api/txs                         must answer 200 with a JSON {valid:[...]} (or array)
 *   - POST /api/submit?dry=1  {kind:"tx", body:{}}
 *       an empty, unsigned, typeless body: minepoa rejects it as malformed even without dry=1,
 *       so the probe can never move funds. A JSON validation answer (400/422, or 200) means the
 *       submit path is up; 401/403/408/429/5xx, non-JSON pages, timeouts and network errors mean
 *       it cannot accept transactions.
 * Real failures seen by the settlement (payout broadcast, parents fetch, player broadcast with an
 * auth/server/network error) are reported too and pause trading at once.
 *
 * Busy is not down: an answer with retry_after (429/503 "origin busy"), or a timeout, means minepoa is
 * overloaded, not refusing transactions. That is DEGRADED: shown in health, payouts back off and keep
 * their signed bodies, and bets stay open (a player's broadcast that fails is refused with nothing
 * booked, so accepting bets while degraded cannot book anything that is not on the ledger).
 *
 * Hysteresis: OK → UNAVAILABLE after `failThreshold` consecutive failed probes (or one real failure);
 * UNAVAILABLE → OK only after `recoverThreshold` consecutive healthy probes AND `minHoldMs` in the hold.
 */

export const LEDGER_HOLD = 'LEDGER_UNAVAILABLE';
export const LEDGER_HOLD_REASON = "Betting is paused: the PoA ledger isn't accepting transactions right now. It resumes automatically.";

const UNHEALTHY_STATUS = (s) => s === 401 || s === 403 || s === 404 || s === 405 || s === 408 || s === 429 || s >= 500 || s === 0;

/** Is this broadcast / fetch error a ledger-availability problem (not a verdict on the tx)? */
export function isLedgerOutage(err) {
  if (!err) return false;
  const status = Number(err.status ?? NaN);
  if (Number.isFinite(status)) return UNHEALTHY_STATUS(status);
  return /HTTP (401|403|408|429|5\d\d)|network|timeout|timed out|ECONN|ENOTFOUND|fetch failed|aborted/i.test(String(err.message || err));
}

/** Overload, not outage: minepoa asked to retry later, or did not answer in time. */
export function isLedgerBusy(err) {
  if (!err) return false;
  if (err.busy || err.timeout || err.name === 'BusyError' || err.name === 'TimeoutError') return true;
  if (Number(err.status) === 429) return true;
  if (err.body && Number(err.body.retry_after_seconds) > 0) return true;
  return /busy|retry after|timeout|timed out|aborted/i.test(String(err.message || err));
}

export class LedgerProbe {
  constructor({ nodeUrl = 'https://minepoa.com', fetchImpl = globalThis.fetch, intervalMs = 20000, failThreshold = 2, recoverThreshold = 2, minHoldMs = 30000, timeoutMs = 8000, now = () => Date.now(), onChange = null } = {}) {
    this.nodeUrl = String(nodeUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.intervalMs = intervalMs;
    this.failThreshold = Math.max(1, failThreshold);
    this.recoverThreshold = Math.max(1, recoverThreshold);
    this.minHoldMs = minHoldMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.onChange = onChange;
    this.status = 'OK';
    this.since = null;
    this.degradedSince = null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastProbeAt = null;
    this.lastOkAt = null;
    this.consecutiveFails = 0;
    this.consecutiveOks = 0;
    this.lastChecks = null;
    this._inflight = null;
  }

  /** null when the ledger accepts transactions; otherwise the hold. */
  hold() {
    return this.status === 'UNAVAILABLE' ? { status: LEDGER_HOLD, reason: LEDGER_HOLD_REASON, since: this.since, lastError: this.lastError } : null;
  }

  nextProbeAt() {
    return this.lastProbeAt === null ? this.now() : this.lastProbeAt + this.intervalMs;
  }

  view() {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return {
      status: this.status,
      since: iso(this.since),
      degradedSince: iso(this.degradedSince),
      lastError: this.lastError,
      lastErrorAt: iso(this.lastErrorAt),
      lastProbeAt: iso(this.lastProbeAt),
      lastOkAt: iso(this.lastOkAt),
      nextProbeAt: iso(this.nextProbeAt()),
      consecutiveFails: this.consecutiveFails,
      consecutiveOks: this.consecutiveOks,
      checks: this.lastChecks
    };
  }

  /** Probe if the cached result is older than intervalMs (concurrent callers share one probe). */
  async maybeProbe() {
    if (this.lastProbeAt !== null && this.now() - this.lastProbeAt < this.intervalMs) return this.hold();
    return this.probe();
  }

  async probe() {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      const [txs, submit] = await Promise.all([this._checkTxs(), this._checkSubmit()]);
      this.lastProbeAt = this.now();
      this.lastChecks = { txs, submit };
      const bad = [txs, submit].filter((c) => !c.ok);
      const msg = `probe: ${bad.map((c) => `${c.name} ${c.detail}`).join('; ')}`;
      if (!bad.length) this._ok();
      else if (bad.every((c) => c.busy)) this._degrade(msg);
      else this._fail(msg, false);
      return this.hold();
    })().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  /** A real attempt failed for an availability reason: pause at once. */
  reportFailure(where, err) {
    if (isLedgerBusy(err)) {
      this._degrade(`${where}: ${String(err?.message || err).slice(0, 200)}`);
      return true;
    }
    if (!isLedgerOutage(err)) return false;
    this._fail(`${where}: ${String(err?.message || err).slice(0, 200)}`, true);
    return true;
  }

  /** Busy / slow: reported, never a trading hold. Cleared by the next healthy probe. */
  _degrade(message) {
    this.lastError = message;
    this.lastErrorAt = this.now();
    if (this.status === 'OK') {
      this.status = 'DEGRADED';
      this.degradedSince = this.now();
      this._changed({});
    }
  }

  _ok() {
    this.lastOkAt = this.now();
    if (this.status === 'DEGRADED') {
      this.status = 'OK';
      this.degradedSince = null;
      this._changed({ recoveredAt: new Date(this.now()).toISOString() });
    }
    this.consecutiveFails = 0;
    this.consecutiveOks += 1;
    if (this.status === 'UNAVAILABLE' && this.consecutiveOks >= this.recoverThreshold && this.now() - this.since >= this.minHoldMs) {
      this.status = 'OK';
      const was = this.since;
      this.since = null;
      this._changed({ resumedAt: new Date(this.now()).toISOString(), pausedSince: new Date(was).toISOString() });
    }
  }

  _fail(message, immediate) {
    if (this.status === 'DEGRADED') {
      this.status = 'OK';
      this.degradedSince = null;
    }
    this.lastError = message;
    this.lastErrorAt = this.now();
    this.consecutiveOks = 0;
    this.consecutiveFails += 1;
    if (this.status === 'OK' && (immediate || this.consecutiveFails >= this.failThreshold)) {
      this.status = 'UNAVAILABLE';
      this.since = this.now();
      this._changed({});
    }
  }

  _changed(extra) {
    if (typeof this.onChange === 'function') {
      try {
        this.onChange({ ...this.view(), ...extra });
      } catch {
        // ignore listener errors
      }
    }
  }

  async _req(path, init) {
    const t0 = this.now();
    try {
      const resp = await this.fetch(`${this.nodeUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await resp.text().catch(() => '');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: resp.status, json, ms: this.now() - t0 };
    } catch (err) {
      return { status: 0, json: null, ms: this.now() - t0, error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err) };
    }
  }

  async _checkTxs() {
    const r = await this._req('/api/txs', { headers: { Accept: 'application/json', 'User-Agent': 'poa-dice-probe/1.0' } });
    const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.valid) ? r.json.valid : null;
    const ok = r.status === 200 && list !== null;
    return { name: '/api/txs', ok, busy: !ok && probeBusy(r), status: r.status, ms: r.ms, detail: ok ? 'ok' : r.error || `HTTP ${r.status}${r.json?.error ? ` ${String(r.json.error).slice(0, 80)}` : ''}` };
  }

  async _checkSubmit() {
    const r = await this._req('/api/submit?dry=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'poa-dice-probe/1.0' },
      body: JSON.stringify({ kind: 'tx', body: {} })
    });
    const ok = r.json !== null && !UNHEALTHY_STATUS(r.status) && (r.status === 200 || (r.status >= 400 && r.status < 500));
    return { name: '/api/submit', ok, busy: !ok && probeBusy(r), status: r.status, ms: r.ms, detail: ok ? 'ok' : r.error || `HTTP ${r.status}${r.json?.error ? ` ${String(r.json.error).slice(0, 80)}` : ''}` };
  }
}

/** A probe answer that means "overloaded, retry later" (or no answer in time), not "cannot accept". */
function probeBusy(r) {
  if (r.error === 'timeout') return true;
  if (r.status === 429) return true;
  return (r.status === 503 || r.status === 200) && Number(r.json?.retry_after_seconds) > 0;
}
