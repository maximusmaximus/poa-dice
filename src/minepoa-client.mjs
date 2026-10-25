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
 *
 * Tx bodies follow poa.mjs buildTx: {type, from, to, amount, memo, nonce, parents[2], ts, cid, sig},
 * txid = sha256(canonical(body without sig)).
 */
import { fetchExplorerAddress } from './chain-feed.mjs';

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
  constructor({ nodeUrl = 'https://minepoa.com', fetchImpl = globalThis.fetch, chainId = DEFAULT_CHAIN_ID, timeoutMs = 12000 } = {}) {
    this.nodeUrl = String(nodeUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.chainId = chainId;
    this.timeoutMs = timeoutMs;
  }

  explorerTxUrl(txid) {
    return `${this.nodeUrl}/api/explorer/tx/${txid}`;
  }

  async _get(path) {
    const resp = await this.fetch(`${this.nodeUrl}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'poa-dice-settlement/1.0' },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`minepoa ${path.split('?')[0]} -> HTTP ${resp.status}`);
    return resp.json();
  }

  getAddress(address) {
    return fetchExplorerAddress(this.nodeUrl, address, this.fetch);
  }

  /** null when the node has never seen the tx. */
  async getTx(txid) {
    const j = await this._get(`/api/explorer/tx/${encodeURIComponent(txid)}`);
    if (!j || !j.id) return null;
    const body = j.body || {};
    return {
      id: j.id,
      atts: Number(j.atts || 0),
      final: j.final === true || j.final === 1 || j.final === '1',
      invalid: j.invalid === true || j.status === 'invalid',
      body,
      from: body.from || j.from_addr || j.from,
      to: body.to || j.to_addr || j.to,
      amount: body.amount || j.amount,
      memo: body.memo ?? j.memo ?? '',
      ts: body.ts || j.ts
    };
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
