// @ts-nocheck
/**
 * Local fake minepoa node for tests. Implements the slice of the public API the vault uses:
 *   POST /api/submit, GET /api/explorer/tx/:id, GET /api/explorer/address/:a,
 *   GET /api/receipt/:id, GET /api/txs
 * It checks signatures, nonces (strictly next), balances and the chain id like the real node,
 * and offers fault injection (transient 503s, lost responses, definitive rejections) plus
 * manual finality (finalizeAll) so tests control when a tx counts as confirmed.
 * It never talks to the real minepoa.com.
 */
import http from 'node:http';
import { fromMicros, toMicros, txidOf, verifyBody } from '../../src/crypto-poa.mjs';

export async function startMockMinepoa({ balances = {}, chainId = 'poa-mainnet-1', autoFinal = false, realistic = false, asyncReject = false } = {}) {
  // asyncReject=true mimics minepoa.com on 2026-10-25: /api/submit answers 200 for a body it later refuses,
  // /api/receipt/<id> then says {status:'rejected', error:'bad nonce 5 (expected 6)'} and the explorer
  // answers 404 "not in segments" for that txid.
  const receipts = new Map(); // txid -> rejected receipt
  const hidden = new Set(); // txids the address page does not list yet (read-node lag)
  let readFaults = []; // queue of '503' | 'busy' for GET /api/explorer/tx and /api/receipt
  const bal = new Map(Object.entries(balances).map(([a, v]) => [a, toMicros(v)]));
  // realistic=true mimics minepoa.com read-node v0.2 (observed 2026-10-25):
  //   address pages omit memos, `balance` is as of the last checkpoint, and
  //   /api/explorer/txs?type=transfer lists recent transfers with memo + height.
  let cpBal = new Map(bal);
  let cpHeight = -1;
  let timeoutsLeft = 0;
  const nonces = new Map();
  const txs = new Map(); // id -> {id, body, final, atts, seq}
  let seq = 0;
  const faults = []; // queue of {kind:'503'|'drop'|'lost'|'reject', message}
  const submits = [];
  for (let i = 0; i < 2; i++) {
    const id = `genesis${i}`.padEnd(64, '0');
    txs.set(id, { id, body: { type: 'genesis', ts: 1 + i }, final: true, atts: 5, seq: seq++ });
  }

  function accept(body) {
    const id = txidOf(body);
    bal.set(body.from, (bal.get(body.from) || 0n) - toMicros(body.amount));
    bal.set(body.to, (bal.get(body.to) || 0n) + toMicros(body.amount));
    nonces.set(body.from, body.nonce);
    txs.set(id, { id, body, final: autoFinal, atts: autoFinal ? 5 : 1, seq: seq++ });
    return id;
  }

  function check(body) {
    if (!body || body.type !== 'transfer') return 'only transfers supported by the mock';
    if (body.cid !== chainId) return 'wrong chain id';
    if (!verifyBody(body, body.from)) return 'bad signature';
    const want = (nonces.get(body.from) || 0) + 1;
    if (body.nonce !== want) return asyncReject ? `bad nonce ${body.nonce} (expected ${want})` : `bad nonce: expected ${want}, got ${body.nonce}`;
    if (!Array.isArray(body.parents) || body.parents.some((p) => !txs.has(p))) return 'unknown parents';
    let amt;
    try {
      amt = toMicros(body.amount);
    } catch {
      return 'bad amount';
    }
    if ((bal.get(body.from) || 0n) < amt) return 'insufficient balance';
    return null;
  }

  const json = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  let readBusy = 0; // retry_after_seconds: explorer + receipt reads answer 503 "origin busy" (like 2026-10-26)
  let outage = 0; // when set, these paths answer this HTTP status (minepoa can't accept txs)
  let outagePaths = ['/api/txs', '/api/submit'];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // Ledger probe traffic (poa-dice-probe UA, /api/submit?dry=1) never consumes injected faults or counts as a submit.
    const isProbe = String(req.headers['user-agent'] || '').startsWith('poa-dice-probe');
    if (isProbe || (req.method === 'POST' && p === '/api/submit' && url.searchParams.get('dry') === '1')) {
      if (outage && outagePaths.includes(p)) return json(res, outage, { error: 'outage' });
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) raw += c;
        const { kind, body } = JSON.parse(raw || '{}');
        if (kind !== 'tx') return json(res, 400, { error: 'kind must be tx|att' });
        if (!body || !body.type) return json(res, 400, { error: 'bad tx type' });
        const err = check(body);
        return err ? json(res, 400, { error: err }) : json(res, 200, { ok: true, dry: true, would_accept: true });
      }
    }
    if (outage && outagePaths.includes(p)) return json(res, outage, { error: 'outage' });
    if (req.method === 'GET' && timeoutsLeft > 0) {
      timeoutsLeft -= 1;
      return; // never answer: the client's timeout fires
    }
    if (req.method === 'POST' && p === '/api/submit') {
      let raw = '';
      for await (const c of req) raw += c;
      const { kind, body } = JSON.parse(raw || '{}');
      submits.push(body);
      const fault = faults.shift();
      if (fault?.kind === '503') return json(res, 503, { error: 'node busy' });
      if (fault?.kind === 'drop') return req.socket.destroy();
      if (fault?.kind === 'reject') return json(res, 400, { error: fault.message || 'rejected' });
      if (fault?.kind === 'busy') return json(res, 503, { error: 'origin busy — retry shortly', retry_after_seconds: fault.retryAfter ?? 1 });
      // blackhole: the node says "queued" but the tx never reaches the ledger (and has no receipt)
      if (fault?.kind === 'blackhole') return json(res, 200, { ok: true, id: txidOf(body), queued: true });
      if (kind !== 'tx') return json(res, 400, { error: 'kind must be tx' });
      const id = txidOf(body);
      if (txs.has(id)) return json(res, 409, { error: 'duplicate tx' });
      const err = check(body);
      if (err && asyncReject) {
        receipts.set(id, { txid: id, ts: Math.floor(Date.now() / 1000), status: 'rejected', error: err });
        return json(res, 200, { ok: true, txid: id, queued: true });
      }
      if (err) return json(res, 400, { error: err });
      accept(body);
      if (fault?.kind === 'lost') return json(res, 503, { error: 'gateway timeout (but accepted)' });
      return json(res, 200, { ok: true, txid: id, next_nonce: body.nonce + 1 });
    }
    let m;
    if (req.method === 'GET' && readBusy && /^\/api\/(explorer\/(tx|address)|receipt)\//.test(p)) {
      return json(res, 503, { error: 'origin busy — served capacity is reserved for mining/grading right now; retry shortly', retry_after_seconds: readBusy });
    }
    if (req.method === 'GET' && readFaults.length && /^\/api\/(explorer\/tx|receipt)\//.test(p)) {
      const f = readFaults.shift();
      if (f === 'busy') return json(res, 200, { error: 'origin busy, retry' });
      return json(res, 503, { error: 'read node busy' });
    }
    if ((m = p.match(/^\/api\/explorer\/tx\/(.+)$/))) {
      const t = txs.get(m[1]);
      if (!t) return json(res, 404, { error: asyncReject ? 'not in segments' : 'not found' });
      return json(res, 200, { id: t.id, type: t.body.type, from_addr: t.body.from, to_addr: t.body.to, amount: t.body.amount, memo: t.body.memo, ts: t.body.ts, atts: t.atts, final: t.final ? 1 : 0, body: t.body });
    }
    if ((m = p.match(/^\/api\/explorer\/address\/(.+)$/))) {
      const a = decodeURIComponent(m[1]);
      const list = [...txs.values()]
        .filter((t) => (t.body.from === a || t.body.to === a) && !hidden.has(t.id))
        .sort((x, y) => y.seq - x.seq)
        .map((t) => {
          const row = { id: t.id, type: t.body.type, from_addr: t.body.from, to_addr: t.body.to, amount: t.body.amount, memo: t.body.memo, ts: t.body.ts, atts: t.atts, final: t.final ? 1 : 0 };
          if (realistic) delete row.memo;
          return row;
        });
      if (realistic) return json(res, 200, { address: a, balance: fromMicros(cpBal.get(a) || 0n), balance_as_of: { checkpoint_height: cpHeight }, txs: list, checkpoint_height: cpHeight });
      return json(res, 200, { address: a, balance: fromMicros(bal.get(a) || 0n), txs: list, checkpoint_height: seq });
    }
    if (p === '/api/explorer/txs') {
      if (!realistic) return json(res, 404, { error: 'mock: not enabled' });
      const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));
      const type = url.searchParams.get('type');
      const list = [...txs.values()]
        .filter((t) => !type || t.body.type === type)
        .sort((x, y) => y.seq - x.seq)
        .slice(0, limit)
        .map((t) => ({ id: t.id, type: t.body.type, from_addr: t.body.from, to_addr: t.body.to, amount: t.body.amount, memo: t.body.memo || '', ts: t.body.ts, atts: t.atts, final: t.final ? 1 : 0, height: t.seq }));
      return json(res, 200, list);
    }
    if ((m = p.match(/^\/api\/receipt\/(.+)$/))) {
      if (receipts.has(m[1]) && !txs.has(m[1])) return json(res, 200, receipts.get(m[1]));
      const t = txs.get(m[1]);
      if (!t) return json(res, 404, { error: 'not found' });
      return json(res, 200, { txid: t.id, status: 'included', from: t.body.from, next_nonce: (nonces.get(t.body.from) || 0) + 1 });
    }
    if (p === '/api/txs') {
      const valid = [...txs.values()].sort((x, y) => y.seq - x.seq).slice(0, 50).map((t) => ({ id: t.id, ts: t.seq, final: t.final }));
      return json(res, 200, { valid });
    }
    return json(res, 404, { error: 'mock: unknown path' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    submits,
    setOutage: (status, paths = ['/api/txs', '/api/submit']) => { outage = status || 0; outagePaths = paths; },
    balanceOf: (a) => fromMicros(bal.get(a) || 0n),
    setBalance: (a, v) => bal.set(a, toMicros(v)),
    /** Sign a checkpoint covering everything so far (realistic mode balances catch up). */
    checkpoint: () => {
      cpBal = new Map(bal);
      cpHeight = seq - 1;
    },
    checkpointBalanceOf: (a) => fromMicros(cpBal.get(a) || 0n),
    /** The next n GET requests hang (client timeout path). */
    hangNext: (n = 1) => {
      timeoutsLeft = n;
    },
    finalizeAll: () => {
      for (const t of txs.values()) {
        t.final = true;
        t.atts = 5;
      }
    },
    tx: (id) => txs.get(id),
    transfersFrom: (a) => [...txs.values()].filter((t) => t.body.from === a && t.body.type === 'transfer'),
    inject: (...f) => faults.push(...f),
    clearFaults: () => faults.splice(0),
    /** A direct ledger transfer (like `poa.mjs send`), bypassing the vault API. */
    directSubmit(body) {
      const err = check(body);
      if (err) throw new Error(err);
      return accept(body);
    },
    nextNonce: (a) => (nonces.get(a) || 0) + 1,
    receipt: (id) => receipts.get(id) || null,
    /** The address page stops listing these txids (read-node lag) until unhideAll(). */
    hide: (...ids) => ids.forEach((id) => hidden.add(id)),
    unhideAll: () => hidden.clear(),
    /** The next GETs of /api/explorer/tx/* and /api/receipt/* fail: '503' or 'busy' (200 with an error). */
    failReads: (...modes) => {
      readFaults = readFaults.concat(modes);
    },
    /** Explorer and receipt reads answer 503 "origin busy" with retry_after_seconds (0 = off). */
    setReadBusy: (seconds = 60) => {
      readBusy = seconds || 0;
    },
    clearReadFaults: () => {
      readFaults = [];
    },
    parents: () => [...txs.values()].sort((x, y) => y.seq - x.seq).slice(0, 2).map((t) => t.id).reverse(),
    close: () => new Promise((r) => server.close(r))
  };
}
