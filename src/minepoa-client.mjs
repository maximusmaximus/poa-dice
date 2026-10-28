// @ts-nocheck
/**
 * minepoa-client.mjs: the small slice of the public minepoa.com node API the vault needs.
 *
 *   POST /api/submit                 {kind:"tx", body}   broadcast a signed tx (same as poa.mjs submitToNode)
 *   GET  /api/explorer/tx/<txid>     {id, atts, final, body, ...}   inclusion + finality (K=5 attestations
 *                                    or checkpoint coverage)
 *   GET  /api/receipt/<txid>         {status, next_nonce, checkpoint_covered}
 *   GET  /api/explorer/address/<a>   {balance, txs[]}
 *   GET  /api/txs                    {valid: [...]}    recent valid txs (parents for new txs)
 *   GET  /api/explorer/txs?type=transfer&limit=200   recent transfers WITH memo + height
 *
 * Real-node quirks this client handles (seen on minepoa.com read-node v0.2, 2026-10-25):
 *   - /api/explorer/address/<a> lists txs WITHOUT the memo field, so a memo filter on that list
 *     silently drops every DICE1 transfer. Memos come from /api/explorer/tx/<id> (cached here).
 *   - The address `balance` is the balance as of the last signed checkpoint
 *     (`balance_as_of.checkpoint_height`). Final txs above that height are NOT in it yet.
 *   - The read node sometimes answers 503 "origin busy" with retry_after_seconds. A short retry_after
 *     (up to 5 s) is retried inside the call; a longer one opens a busy window (reads and submits are
 *     tracked separately): calls in that window fail fast with BusyError instead of waiting, so a
 *     bounded settlement pass is not spent sleeping. Callers treat it as "unknown", never as a verdict.
 *
 * Tx bodies follow poa.mjs buildTx: {type, from, to, amount, memo, nonce, parents[2], ts, cid, sig},
 * txid = sha256(canonical(body without sig)).
 */
import { normalizeExplorerTx } from './chain-feed.mjs';
import { toMicros } from './crypto-poa.mjs';

export const DEFAULT_CHAIN_ID = 'poa-mainnet-1';

export class SubmitError extends Error {
  constructor(message, { status = 0, definitive = false, body = null } = {}) {
    super(message);
    this.name = 'SubmitError';
    this.status = status;
    // definitive: the node looked at the tx and refused it, so it can never land as submitted.
    this.definitive = definitive;
    this.body = body;
  }
}

/** minepoa asked us to come back later (retry_after) or is inside such a window. Never a verdict on a tx. */
export class BusyError extends Error {
  constructor(message, { retryAfterMs = 0, scope = 'read' } = {}) {
    super(message);
    this.name = 'BusyError';
    this.busy = true;
    this.status = 503;
    this.definitive = false;
    this.retryAfterMs = retryAfterMs;
    this.scope = scope;
  }
}

const IN_CALL_RETRY_AFTER_MS = 5000;

export class MinepoaClient {
  constructor({
    nodeUrl = 'https://minepoa.com',
    fetchImpl = globalThis.fetch,
    chainId = DEFAULT_CHAIN_ID,
    timeoutMs = Number(process.env.POA_MINEPOA_TIMEOUT_MS || 25000),
    retries = Number(process.env.POA_MINEPOA_RETRIES || 3),
    retryBaseMs = 400,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    busyMaxMs = 60000
  } = {}) {
    this.nodeUrl = String(nodeUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.chainId = chainId;
    this.timeoutMs = timeoutMs;
    this.retries = Math.max(1, retries);
    this.retryBaseMs = retryBaseMs;
    this.sleep = sleep;
    this._memoCache = new Map(); // txid -> memo (memos are immutable once on the ledger)
    this.stats = { calls: 0, retries: 0, timeouts: 0, lastLatencyMs: null, busy: 0, busyFastFails: 0 };
    this.busyMaxMs = busyMaxMs;
    // Busy windows per minepoa surface: the explorer ('read'), receipts, /api/txs, and submits. The
    // explorer can be "origin busy" while receipts still answer (seen live 2026-10-26).
    this._busyUntil = { read: 0, receipt: 0, txs: 0, submit: 0 };
  }

  /** {until, scope} while minepoa's retry_after window for this scope is open; else null. */
  busy(scope = 'read') {
    const until = this._busyUntil[scope] || 0;
    return until > Date.now() ? { scope, until, retryAfterMs: until - Date.now() } : null;
  }

  busyView() {
    const iso = (t) => (t > Date.now() ? new Date(t).toISOString() : null);
    return { readBusyUntil: iso(this._busyUntil.read), receiptBusyUntil: iso(this._busyUntil.receipt), txsBusyUntil: iso(this._busyUntil.txs), submitBusyUntil: iso(this._busyUntil.submit) };
  }

  _noteBusy(scope, retryAfterMs) {
    const ms = Math.min(this.busyMaxMs, Math.max(1000, retryAfterMs));
    for (const k of Object.keys(this._busyUntil)) if (k.startsWith('tx:') && this._busyUntil[k] <= Date.now()) delete this._busyUntil[k];
    this._busyUntil[scope] = Math.max(this._busyUntil[scope] || 0, Date.now() + ms);
    this.stats.busy += 1;
    return ms;
  }

  _failFast(scope, what) {
    const b = this.busy(scope);
    if (!b) return;
    this.stats.busyFastFails += 1;
    throw new BusyError(`minepoa ${what} -> busy (retry after ${Math.ceil(b.retryAfterMs / 1000)} s)`, { retryAfterMs: b.retryAfterMs, scope });
  }

  explorerTxUrl(txid) {
    return `${this.nodeUrl}/api/explorer/tx/${txid}`;
  }

  /**
   * GET with a per-attempt timeout and retries (network error, timeout, 429, 5xx).
   * Each attempt gets a FRESH timeout signal, so a process that was frozen between requests
   * (serverless) does not fail on a signal whose clock ran while it was asleep.
   */
  static busyScope(path) {
    if (path.startsWith('/api/receipt/')) return 'receipt';
    if (path.startsWith('/api/txs')) return 'txs';
    return 'read';
  }

  async _get(path, { scope: scopeOverride = null } = {}) {
    let lastErr = null;
    const scope = scopeOverride || MinepoaClient.busyScope(path);
    this._failFast(scope, path.split('?')[0]);
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const t0 = Date.now();
      this.stats.calls += 1;
      let resp;
      try {
        resp = await this.fetch(`${this.nodeUrl}${path}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'poa-dice-settlement/1.1' },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (err) {
        if (err && (err.name === 'TimeoutError' || /timeout/i.test(String(err.message)))) this.stats.timeouts += 1;
        lastErr = new Error(`minepoa ${path.split('?')[0]} -> ${err?.message || err}`);
        if (attempt < this.retries) {
          this.stats.retries += 1;
          await this.sleep(this._retryDelay(attempt));
        }
        continue;
      }
      this.stats.lastLatencyMs = Date.now() - t0;
      if (resp.status === 404) return null;
      if (resp.ok) {
        const body = await resp.json();
        const ra = Number(body?.retry_after_seconds || 0) * 1000;
        if (body && !body.id && body.error && ra > IN_CALL_RETRY_AFTER_MS) {
          const ms = this._noteBusy(scope, ra);
          throw new BusyError(`minepoa ${path.split('?')[0]} -> busy: ${String(body.error).slice(0, 80)}`, { retryAfterMs: ms, scope });
        }
        return body;
      }
      let retryAfterMs = 0;
      if (resp.status === 429 || resp.status >= 500) {
        const j = await resp.json().catch(() => null);
        const ra = Number(j?.retry_after_seconds || resp.headers?.get?.('retry-after') || 0) * 1000 || 0;
        if (ra > IN_CALL_RETRY_AFTER_MS) {
          const ms = this._noteBusy(scope, ra);
          throw new BusyError(`minepoa ${path.split('?')[0]} -> HTTP ${resp.status} busy${j?.error ? `: ${String(j.error).slice(0, 80)}` : ''}`, { retryAfterMs: ms, scope });
        }
        retryAfterMs = Math.min(IN_CALL_RETRY_AFTER_MS, ra);
        lastErr = new Error(`minepoa ${path.split('?')[0]} -> HTTP ${resp.status}`);
        if (attempt < this.retries) {
          this.stats.retries += 1;
          await this.sleep(Math.max(retryAfterMs, this._retryDelay(attempt)));
        }
        continue;
      }
      throw new Error(`minepoa ${path.split('?')[0]} -> HTTP ${resp.status}`);
    }
    throw lastErr || new Error(`minepoa ${path} failed`);
  }

  _retryDelay(attempt) {
    return Math.round(this.retryBaseMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
  }

  /**
   * Address page. `balance` is the CHECKPOINT balance (see header); `checkpoint` is its height.
   * Txs are normalized; the node omits memos here, so memo is '' unless the node sends it.
   */
  async getAddress(address) {
    const data = await this._get(`/api/explorer/address/${encodeURIComponent(address)}?sort=new`);
    if (!data) throw new Error(`Explorer has no page for ${address}`);
    const balance = typeof data.balance === 'string' ? data.balance : '0.000000';
    const txs = Array.isArray(data.txs) ? data.txs.map((t) => ({ ...normalizeExplorerTx(t), memoKnown: t && t.memo !== undefined, atts: Number(t?.atts || 0), final: t?.final === true || t?.final === 1 || t?.final === '1' })) : [];
    return {
      address,
      balance,
      balanceMicros: toMicros(balance || '0').toString(),
      checkpoint: data.balance_as_of?.checkpoint_height ?? data.checkpoint_height ?? null,
      asOf: data.as_of || null,
      txs
    };
  }

  /** Recent transfers with memo and height ({id -> row}); used to see what a checkpoint does not cover yet. */
  async getRecentTransfers(limit = 200) {
    const j = await this._get(`/api/explorer/txs?type=transfer&limit=${limit}`);
    const list = Array.isArray(j) ? j : Array.isArray(j?.txs) ? j.txs : [];
    const out = new Map();
    for (const t of list) {
      if (!t || !t.id || (t.type && t.type !== 'transfer')) continue;
      const row = { ...normalizeExplorerTx(t), height: t.height == null ? null : Number(t.height), atts: Number(t.atts || 0), final: t.final === true || t.final === 1 || t.final === '1' };
      if (typeof t.memo === 'string') this._memoCache.set(t.id, t.memo);
      out.set(t.id, row);
    }
    return out;
  }

  /** Memo of a ledger tx (cached). undefined when the node could not be asked. */
  async getMemo(txid) {
    if (this._memoCache.has(txid)) return this._memoCache.get(txid);
    const tx = await this.getTx(txid);
    if (!tx) return null;
    return String(tx.memo || '');
  }

  /**
   * null when the node has never seen the tx.
   * opts.isolateBusy: a busy answer for THIS txid opens a busy window for this txid only, not for every
   * explorer read. minepoa has answered 503 "origin busy" for unknown txids while it still answered real
   * ones normally (2026-10-27), so one unknown tx must not make every other lookup fail fast.
   */
  async getTx(txid, { isolateBusy = false } = {}) {
    const path = `/api/explorer/tx/${encodeURIComponent(txid)}`;
    const j = await this._get(path, isolateBusy ? { scope: `tx:${txid}` } : {});
    if (!j) return null;
    if (!j.id) {
      // Only an explicit "unknown / not found" means never seen. A read node that is re-deriving
      // ("not in segments", busy) does not know: throw so callers treat it as unknown (never re-sign on it).
      if (j.error && !/unknown txid|not found|no such|not seen/i.test(String(j.error))) throw new Error(`minepoa explorer cannot answer for ${txid}: ${String(j.error).slice(0, 120)}`);
      return null;
    }
    const body = j.body || {};
    const out = {
      id: j.id,
      atts: Number(j.atts || 0),
      final: j.final === true || j.final === 1 || j.final === '1',
      invalid: j.invalid === true || j.status === 'invalid',
      body,
      from: body.from || j.from_addr || j.from,
      to: body.to || j.to_addr || j.to,
      amount: body.amount || j.amount,
      memo: body.memo ?? j.memo ?? '',
      ts: body.ts || j.ts,
      height: j.height == null ? null : Number(j.height)
    };
    if (typeof out.memo === 'string') this._memoCache.set(out.id, out.memo);
    return out;
  }

  getReceipt(txid) {
    return this._get(`/api/receipt/${encodeURIComponent(txid)}`);
  }

  /**
   * What minepoa's receipt endpoint says about a txid, keeping the 404 body (getReceipt maps every 404
   * to null). Used when the explorer cannot answer for one tx.
   *   {state:'unknown'}             definite 404 "unknown txid" (not seen by this node)
   *   {state:'rejected', receipt}   the node refused it (never on the ledger)
   *   {state:'known', receipt}      queued / included / final: the node has it
   *   {state:'unavailable', error}  busy, timeout, or any other answer: no verdict
   */
  async receiptLookup(txid) {
    const path = `/api/receipt/${encodeURIComponent(txid)}`;
    try {
      this._failFast('receipt', '/api/receipt');
    } catch (err) {
      return { state: 'unavailable', error: err.message };
    }
    let resp;
    this.stats.calls += 1;
    try {
      resp = await this.fetch(`${this.nodeUrl}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'poa-dice-settlement/1.1' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      return { state: 'unavailable', error: `minepoa /api/receipt -> ${err?.message || err}` };
    }
    const j = await resp.json().catch(() => null);
    const errText = String(j?.error || '');
    if (resp.status === 404) {
      if (j && /unknown txid|not seen by|^not found$/i.test(errText)) return { state: 'unknown' };
      return { state: 'unavailable', error: `minepoa /api/receipt -> HTTP 404${errText ? `: ${errText.slice(0, 80)}` : ''}` };
    }
    if (resp.ok && j && !j.error && (!j.txid || j.txid === txid) && j.status) {
      return /^(rejected|invalid|failed)$/i.test(String(j.status)) ? { state: 'rejected', receipt: j } : { state: 'known', receipt: j };
    }
    if (resp.ok && j && j.error && /rejected|invalid/i.test(String(j.status || ''))) return { state: 'rejected', receipt: j };
    const ra = Number(j?.retry_after_seconds || resp.headers?.get?.('retry-after') || 0) * 1000 || 0;
    if ((resp.status === 429 || resp.status >= 500 || (resp.ok && j?.error)) && ra > IN_CALL_RETRY_AFTER_MS) this._noteBusy('receipt', ra);
    return { state: 'unavailable', error: `minepoa /api/receipt -> HTTP ${resp.status}${errText ? `: ${errText.slice(0, 80)}` : ''}` };
  }

  /** Two most recent valid txids, oldest first (what poa.mjs buildTx uses as parents). */
  async getTipParents() {
    const j = await this._get('/api/txs');
    const list = Array.isArray(j?.valid) ? j.valid : Array.isArray(j) ? j : [];
    const sorted = list.filter((t) => t && t.id).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return sorted.slice(-2).map((t) => t.id);
  }

  /** Next nonce for an address: receipt.next_nonce of its newest sent tx, else 1. */
  async nextNonce(address) {
    const row = await this.getAddress(address);
    const sent = (row.txs || []).filter((t) => t && t.from === address && t.id).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (sent.length === 0) return 1;
    const receipt = await this.getReceipt(sent[0].id).catch(() => null);
    if (receipt && Number.isInteger(Number(receipt.next_nonce)) && Number(receipt.next_nonce) > 0) return Number(receipt.next_nonce);
    const tx = await this.getTx(sent[0].id).catch(() => null);
    if (tx && Number.isInteger(Number(tx.body?.nonce))) return Number(tx.body.nonce) + 1;
    throw new Error(`Could not determine next nonce for ${address}`);
  }

  /** Broadcast. Throws SubmitError; .definitive=true for a 4xx rejection (except 408/409 dup/429). */
  async submitTx(body) {
    this._failFast('submit', '/api/submit');
    let resp;
    try {
      resp = await this.fetch(`${this.nodeUrl}/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'poa-dice-settlement/1.0' },
        body: JSON.stringify({ kind: 'tx', body }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      const e = new SubmitError(`minepoa submit network error: ${err.message}`, { status: 0, definitive: false });
      e.timeout = err?.name === 'TimeoutError' || /timeout|aborted/i.test(String(err?.message));
      throw e;
    }
    const j = await resp.json().catch(() => ({}));
    if (resp.ok) return j || {};
    const ra = Number(j?.retry_after_seconds || resp.headers?.get?.('retry-after') || 0) * 1000 || 0;
    if ((resp.status === 429 || resp.status === 503) && ra > 0) {
      const ms = this._noteBusy('submit', ra);
      const e = new SubmitError(`minepoa submit busy: ${String(j?.error || `HTTP ${resp.status}`).slice(0, 120)}`, { status: resp.status, definitive: false, body: j });
      e.busy = true;
      e.retryAfterMs = ms;
      throw e;
    }
    const msg = String(j?.error || `HTTP ${resp.status}`);
    // 401/403 (auth / gateway) and 404/405 (route gone) say nothing about the tx itself: not definitive.
    const definitive = resp.status >= 400 && resp.status < 500 && ![401, 403, 404, 405, 408, 409, 425, 429].includes(resp.status);
    throw new SubmitError(`minepoa submit rejected: ${msg}`, { status: resp.status, definitive, body: j });
  }
}
