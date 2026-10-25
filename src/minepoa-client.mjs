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
 *   - The read node sometimes answers 503 "origin busy" with retry_after_seconds.
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

export class MinepoaClient {
  constructor({
    nodeUrl = 'https://minepoa.com',
    fetchImpl = globalThis.fetch,
    chainId = DEFAULT_CHAIN_ID,
    timeoutMs = Number(process.env.POA_MINEPOA_TIMEOUT_MS || 25000),
    retries = Number(process.env.POA_MINEPOA_RETRIES || 3),
    retryBaseMs = 400,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = {}) {
    this.nodeUrl = String(nodeUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.chainId = chainId;
    this.timeoutMs = timeoutMs;
    this.retries = Math.max(1, retries);
    this.retryBaseMs = retryBaseMs;
    this.sleep = sleep;
    this._memoCache = new Map(); // txid -> memo (memos are immutable once on the ledger)
    this.stats = { calls: 0, retries: 0, timeouts: 0, lastLatencyMs: null };
  }

  explorerTxUrl(txid) {
    return `${this.nodeUrl}/api/explorer/tx/${txid}`;
  }

  /**
   * GET with a per-attempt timeout and retries (network error, timeout, 429, 5xx).
   * Each attempt gets a FRESH timeout signal, so a process that was frozen between requests
   * (serverless) does not fail on a signal whose clock ran while it was asleep.
   */
  async _get(path) {
    let lastErr = null;
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
      if (resp.ok) return resp.json();
      let retryAfterMs = 0;
      if (resp.status === 429 || resp.status >= 500) {
        const j = await resp.json().catch(() => null);
        retryAfterMs = Math.min(5000, Number(j?.retry_after_seconds || resp.headers?.get?.('retry-after') || 0) * 1000) || 0;
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

  /** null when the node has never seen the tx. */
  async getTx(txid) {
    const j = await this._get(`/api/explorer/tx/${encodeURIComponent(txid)}`);
    if (!j || !j.id) return null;
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
    let resp;
    try {
      resp = await this.fetch(`${this.nodeUrl}/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'poa-dice-settlement/1.0' },
        body: JSON.stringify({ kind: 'tx', body }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      throw new SubmitError(`minepoa submit network error: ${err.message}`, { status: 0, definitive: false });
    }
    const j = await resp.json().catch(() => ({}));
    if (resp.ok) return j || {};
    const msg = String(j?.error || `HTTP ${resp.status}`);
    const definitive = resp.status >= 400 && resp.status < 500 && ![408, 409, 425, 429].includes(resp.status);
    throw new SubmitError(`minepoa submit rejected: ${msg}`, { status: resp.status, definitive, body: j });
  }
}
