/**
 * POAScan (https://poascan.io) read client: an index of poa-mainnet-1 that is run separately from minepoa.
 *
 * Used by the admin re-pay checks as a second, independent answer to "does this txid exist?". minepoa's
 * read node can say "not in segments" or "origin busy" for a tx it simply has not indexed, and its address
 * pages can omit a transfer that is final and checkpointed (seen live on 2026-10-26 for payout 269433a2),
 * so a minepoa "not found" alone never proves a payout was dropped.
 *
 * Every answer is one of: found (with the record), definitely not found, or an error (throw). Only an
 * explicit 404 with found:false / node:"not_found" for the same txid counts as not found; a 429, 5xx,
 * timeout, malformed body or any other shape throws, so callers refuse.
 */

export class PoaScanError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'PoaScanError';
    this.status = status;
  }
}

export class PoaScanClient {
  constructor({ baseUrl = 'https://poascan.io', fetchImpl = globalThis.fetch, timeoutMs = 15000, retries = 3, retryBaseMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = Math.max(1, retries);
    this.retryBaseMs = retryBaseMs;
    this.sleep = sleep;
    this.name = 'POAScan';
  }

  /** {status, body} for a GET, retrying 429/5xx/network errors; a 404 is returned (it can be an answer). */
  async _get(path) {
    let last = null;
    for (let i = 0; i < this.retries; i++) {
      if (i) await this.sleep(this.retryBaseMs * i);
      let resp;
      try {
        resp = await this.fetch(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'poa-dice-settlement/1.0' }, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        last = new PoaScanError(`POAScan ${path} network error: ${String(err?.message || err).slice(0, 100)}`);
        continue;
      }
      const body = await resp.json().catch(() => null);
      if (resp.status === 429 || resp.status >= 500) {
        last = new PoaScanError(`POAScan ${path} -> HTTP ${resp.status}${body?.error ? ` ${String(body.error).slice(0, 80)}` : ''}`, { status: resp.status });
        continue;
      }
      return { status: resp.status, body };
    }
    throw last || new PoaScanError(`POAScan ${path} failed`);
  }

  /** {found:true, tx} | {found:false}; throws when POAScan cannot give a definite answer. */
  async lookupTx(txid) {
    const id = String(txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new PoaScanError(`not a txid: ${String(txid).slice(0, 20)}`);
    const { status, body } = await this._get(`/api/v1/tx/${id}`);
    if (status === 200 && body && String(body.id || '').toLowerCase() === id && body.found !== false) {
      return {
        found: true,
        tx: {
          id,
          from: body.from_addr || body.body?.from || null,
          to: body.to_addr || body.body?.to || null,
          amount: body.amount || body.body?.amount || null,
          memo: body.memo ?? body.body?.memo ?? null,
          nonce: body.body?.nonce ?? null,
          final: body.final === 1 || body.final === true,
          atts: Number(body.atts || 0),
          checkpointHeight: body.checkpointed?.height ?? null,
          source: body.source || null
        }
      };
    }
    if (status === 404 && body && body.found === false && body.node === 'not_found' && String(body.tx || '').toLowerCase() === id) return { found: false };
    throw new PoaScanError(`POAScan gave no definite answer for ${id.slice(0, 16)} (HTTP ${status}${body?.error ? ` ${String(body.error).slice(0, 80)}` : ''})`, { status });
  }

  /** Every transfer POAScan has archived for an address (all pages). Throws on any failed page. */
  async addressTxs(address, { maxPages = 20 } = {}) {
    const out = [];
    let cursor = null;
    let coverage = null;
    for (let page = 0; page < maxPages; page++) {
      const q = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { status, body } = await this._get(`/api/v1/address/${encodeURIComponent(address)}/txs?${q}`);
      if (status !== 200 || !body || !Array.isArray(body.txs)) throw new PoaScanError(`POAScan history for ${address} unreadable (HTTP ${status})`, { status });
      for (const t of body.txs) if (t && t.id) out.push({ id: String(t.id).toLowerCase(), type: t.type || 'transfer', from: t.from_addr || null, to: t.to_addr || null, amount: t.amount || null, memo: t.memo ?? null, final: t.final === 1 || t.final === true, ts: t.ts ?? null });
      if (body.coverage && !coverage) coverage = body.coverage;
      cursor = body.next_cursor || null;
      if (!cursor) {
        // POAScan's own view of how complete its archive is (nonce_gap > 0: it missed some sent txs).
        Object.defineProperty(out, 'coverage', { value: coverage, enumerable: false });
        return out;
      }
    }
    throw new PoaScanError(`POAScan history for ${address} has more than ${maxPages} pages`);
  }
}
