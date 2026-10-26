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
 * Slow is not down. Every answer that means "overloaded or slow" is DEGRADED, never a hold by itself:
 * timeouts (including a body that stops mid-download), network errors, 408/429/5xx, retry_after, and an
 * HTTP 200 whose body is not the expected JSON. DEGRADED is shown in health, payouts back off and keep
 * their signed bodies, and bets stay open (a player's broadcast that fails is refused with nothing
 * booked, so accepting bets while degraded cannot book anything that is not on the ledger).
 *
 * UNAVAILABLE (the trading hold) needs either
 *   - a sustained outage: no healthy probe for `outageHoldMs` (default 10 minutes). The last healthy
 *     probe time is shared through the writer status (noteRemoteOk), so a fresh serverless instance
 *     measures the outage from when ANY instance last saw minepoa healthy, not from its own start; or
 *   - a wrong answer: 401/403/404/405 from the probe (`failThreshold` in a row), or such an answer to a
 *     real payout / player broadcast (at once).
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

/** A wrong answer (the node refuses us / the route is gone): the only failures that pause trading at once. */
const HARD_STATUS = (s) => s === 401 || s === 403 || s === 404 || s === 405;

/** Overload or slowness, not a refusal: retry later, timeouts, network errors, 408/429/5xx. */
export function isLedgerBusy(err) {
  if (!err) return false;
  if (err.busy || err.timeout || err.name === 'BusyError' || err.name === 'TimeoutError') return true;
  const status = Number(err.status ?? NaN);
  if (status === 408 || status === 429 || status >= 500 || status === 0) return true;
  if (err.body && Number(err.body.retry_after_seconds) > 0) return true;
  if (Number.isFinite(status) && HARD_STATUS(status)) return false;
  return /busy|retry after|timeout|timed out|aborted|HTTP (408|429|5\d\d)|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|fetch failed/i.test(String(err.message || err));
}

export class LedgerProbe {
  constructor({ nodeUrl = 'https://minepoa.com', fetchImpl = globalThis.fetch, intervalMs = 20000, failThreshold = 2, recoverThreshold = 2, minHoldMs = 30000, timeoutMs = 8000, outageHoldMs = 10 * 60 * 1000, now = () => Date.now(), onChange = null } = {}) {
    this.nodeUrl = String(nodeUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.intervalMs = intervalMs;
    this.failThreshold = Math.max(1, failThreshold);
    this.recoverThreshold = Math.max(1, recoverThreshold);
    this.minHoldMs = minHoldMs;
    this.timeoutMs = timeoutMs;
    this.outageHoldMs = Math.max(0, Number(outageHoldMs) || 0);
    this.now = now;
    this.bootAt = now();
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
      outageHoldMs: this.outageHoldMs,
      unhealthyForMs: this.status === 'OK' ? 0 : Math.max(0, this.now() - (this.lastOkAt ?? this.bootAt)),
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
      else if (bad.some((c) => c.hard)) this._fail(msg, false);
      else this._degrade(msg);
      return this.hold();
    })().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  /** A real attempt failed for an availability reason: slow → DEGRADED; a wrong answer → pause at once. */
  reportFailure(where, err) {
    if (isLedgerBusy(err)) {
      this._degrade(`${where}: ${String(err?.message || err).slice(0, 200)}`);
      return true;
    }
    if (!isLedgerOutage(err)) return false;
    this._fail(`${where}: ${String(err?.message || err).slice(0, 200)}`, true);
    return true;
  }

  /** Another instance saw minepoa healthy at `ts` (shared through the writer status). */
  noteRemoteOk(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0 || t > this.now()) return;
    if (this.lastOkAt === null || t > this.lastOkAt) this.lastOkAt = t;
  }

  /**
   * Slow / busy: reported, not a hold, until minepoa has had no healthy probe for outageHoldMs
   * (a sustained outage). Cleared by the next healthy probe.
   */
  _degrade(message) {
    this.lastError = message;
    this.lastErrorAt = this.now();
    if (this.status === 'OK') {
      this.status = 'DEGRADED';
      this.degradedSince = this.now();
      this._changed({});
    }
    this.consecutiveOks = 0;
    if (this.status === 'DEGRADED' && this.now() - (this.lastOkAt ?? this.bootAt) >= this.outageHoldMs) {
      this.status = 'UNAVAILABLE';
      this.since = this.now();
      this.degradedSince = null;
      this.lastError = `${message} (no healthy answer from minepoa for ${Math.round((this.now() - (this.lastOkAt ?? this.bootAt)) / 1000)} s)`;
      this._changed({ sustained: true });
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
      let text;
      try {
        text = await resp.text();
      } catch (err) {
        // Headers arrived but the body did not finish in time (/api/txs is ~800 KB): slow, not a bad answer.
        return { status: resp.status, json: null, ms: this.now() - t0, error: err?.name === 'TimeoutError' || /abort|timeout/i.test(String(err?.message)) ? 'timeout' : `body: ${String(err?.message || err).slice(0, 80)}` };
      }
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
    return { name: '/api/txs', ok, busy: !ok && !HARD_STATUS(r.status), hard: !ok && HARD_STATUS(r.status), status: r.status, ms: r.ms, detail: ok ? 'ok' : r.error || `HTTP ${r.status}${r.json?.error ? ` ${String(r.json.error).slice(0, 80)}` : r.status === 200 ? ' (unexpected body)' : ''}` };
  }

  async _checkSubmit() {
    const r = await this._req('/api/submit?dry=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'poa-dice-probe/1.0' },
      body: JSON.stringify({ kind: 'tx', body: {} })
    });
    const ok = r.json !== null && !UNHEALTHY_STATUS(r.status) && (r.status === 200 || (r.status >= 400 && r.status < 500));
    return { name: '/api/submit', ok, busy: !ok && !HARD_STATUS(r.status), hard: !ok && HARD_STATUS(r.status), status: r.status, ms: r.ms, detail: ok ? 'ok' : r.error || `HTTP ${r.status}${r.json?.error ? ` ${String(r.json.error).slice(0, 80)}` : ''}` };
  }
}
