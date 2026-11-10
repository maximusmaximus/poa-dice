// @ts-nocheck
/**
 * wallet-balance.mjs: live, read-only balance for any poa1 address from the public minepoa explorer.
 * Same derivation as the PoA key generator's balance checker (maximusmaximus/poa-keygen check.html).
 *
 * GET /api/explorer/address/<addr> returns `balance` as of the last signed checkpoint, which lags.
 * A tx is covered by that checkpoint when /api/explorer/tx/<id> has `checkpointed`. So:
 *   current   = checkpoint balance + final incoming - final outgoing   (txs the checkpoint doesn't cover)
 *   spendable = current - pending outgoing   (pending incoming isn't counted until it's final)
 * No keys involved; GET requests only.
 */
import { b58dec as b58decode, isValidPoaAddress } from './crypto-poa.mjs';

var K = 5; // peer attestations for finality on minepoa

function b58dec(s) {
  if (typeof s !== 'string' || !s.length) return null;
  try {
    return b58decode(s);
  } catch {
    return null;
  }
}
function isAddress(s) {
  return isValidPoaAddress(s);
}
// A bare base58 string that decodes to 32 or 64 bytes is almost certainly a private key (seed).
function looksLikePrivkey(s) {
  if (typeof s !== 'string') return false;
  s = s.trim();
  if (!s || s.slice(0, 4) === 'poa1' || s.length < 40) return false;
  var raw = b58dec(s);
  return !!raw && (raw.length === 32 || raw.length === 64);
}

function toMicros(s) {
  if (s === null || s === undefined || s === '') return null;
  var m = String(s).trim().match(/^(-?)(\d+)(?:\.(\d{0,6}))?$/);
  if (!m) return null;
  var v = BigInt(m[2]) * 1000000n + BigInt(((m[3] || '') + '000000').slice(0, 6));
  return m[1] ? -v : v;
}
function fromMicros(v) {
  var neg = v < 0n; if (neg) v = -v;
  var frac = String(v % 1000000n); while (frac.length < 6) frac = '0' + frac;
  return (neg ? '-' : '') + String(v / 1000000n) + '.' + frac;
}

// Status of one tx. `detail` is the /api/explorer/tx/<id> body, or {error} if the read node
// could not serve it (it answers "not in segments" briefly while it re-derives).
function txStatus(row, detail) {
  if (detail && detail.checkpointed) return { state: 'final', via: 'checkpoint', height: detail.checkpointed.height, atts: row.atts || 0, covered: true };
  if (detail && detail.finality && detail.finality.via === 'checkpoint') return { state: 'final', via: 'checkpoint', height: detail.finality.height, atts: row.atts || 0, covered: true };
  var src = detail && !detail.error ? detail : row;
  var atts = Number(src.atts) || 0;
  var stale = !!(detail && detail.error);
  if (Number(src.final) === 1) return { state: 'final', via: 'attestations', atts: atts, covered: false, stale: stale };
  return { state: 'pending', atts: atts, need: K, covered: false, stale: stale };
}

/* Pure derivation. addrResp = /api/explorer/address/<addr> body; details = {txid: detail}. */
function derive(address, addrResp, details) {
  details = details || {};
  var cp = toMicros(addrResp.balance);
  if (cp === null) throw new Error('explorer returned no checkpoint balance');
  var cpHeight = addrResp.balance_as_of && addrResp.balance_as_of.checkpoint_height != null ? addrResp.balance_as_of.checkpoint_height : addrResp.checkpoint_height;
  var finalIn = 0n, finalOut = 0n, pendIn = 0n, pendOut = 0n, unknown = 0, catchingUp = false, lastTs = null;
  var rows = (Array.isArray(addrResp.txs) ? addrResp.txs : []).slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  var txs = rows.map(function (r) {
    var d = details[r.id];
    var st = txStatus(r, d);
    if (d === undefined) st.unchecked = true;
    if (st.stale) catchingUp = true;
    var amt = toMicros(r.amount);
    var dir = 'other';
    if (amt !== null && amt > 0n) {
      if (r.from_addr === address && r.to_addr === address) dir = 'self';
      else if (r.to_addr === address) dir = 'in';
      else if (r.from_addr === address) dir = 'out';
    }
    if (r.ts && (lastTs === null || r.ts > lastTs)) lastTs = r.ts;
    // Only txs the checkpoint does not cover change the balance. Unchecked rows are counted too
    // (never assume coverage we could not confirm), and flagged.
    if (!st.covered && (dir === 'in' || dir === 'out')) {
      if (st.unchecked) unknown += 1;
      if (dir === 'in') { if (st.state === 'final') finalIn += amt; else pendIn += amt; }
      else { if (st.state === 'final') finalOut += amt; else pendOut += amt; }
    }
    return {
      id: r.id, type: r.type, ts: r.ts || null, from: r.from_addr || '', to: r.to_addr || '', direction: dir,
      amount: amt === null ? null : fromMicros(amt), memo: d && typeof d.memo === 'string' ? d.memo : null,
      status: st, inCheckpoint: !!st.covered
    };
  });
  var current = cp + finalIn - finalOut;
  var spendable = current - pendOut; if (spendable < 0n) spendable = 0n;
  return {
    address: address,
    checkpoint: { balance: fromMicros(cp), height: cpHeight == null ? null : cpHeight },
    current: fromMicros(current),
    spendable: fromMicros(spendable),
    afterPending: fromMicros(current + pendIn - pendOut),
    sinceCheckpoint: { finalIn: fromMicros(finalIn), finalOut: fromMicros(finalOut), pendingIn: fromMicros(pendIn), pendingOut: fromMicros(pendOut) },
    pendingCount: txs.filter(function (t) { return t.status.state === 'pending'; }).length,
    lastTxTs: lastTs,
    catchingUp: catchingUp,
    unverifiedCoverage: unknown,
    asOf: addrResp.as_of || null,
    txs: txs
  };
}

function NetError(kind, message, extra) { var e = new Error(message); e.kind = kind; if (extra) for (var k in extra) e[k] = extra[k]; return e; }

async function getJson(fetchFn, url, timeoutMs) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 12000) : 0;
  var resp;
  try { resp = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }); }
  catch (e) { throw NetError(e && e.name === 'AbortError' ? 'timeout' : 'network', 'Could not reach minepoa.com'); }
  finally { if (timer) clearTimeout(timer); }
  var body = null;
  try { body = await resp.json(); } catch (e) { body = null; }
  return { status: resp.status, ok: resp.ok, body: body };
}

function makeChecker(opts) {
  opts = opts || {};
  var fetchFn = opts.fetch, node = String(opts.node || 'https://minepoa.com').replace(/\/+$/, '');
  var maxDetails = opts.maxDetails || 60, conc = opts.concurrency || 4, timeoutMs = opts.timeoutMs || 12000;
  var covered = new Map(); // txid -> detail; checkpoint coverage is permanent (bounded LRU)

  async function detailFor(id) {
    if (covered.has(id)) return covered.get(id);
    var r = await getJson(fetchFn, node + '/api/explorer/tx/' + encodeURIComponent(id), timeoutMs);
    if (r.ok && r.body && !r.body.error) {
      if (r.body.checkpointed || (r.body.finality && r.body.finality.via === 'checkpoint')) {
        if (covered.size >= 2000) covered.delete(covered.keys().next().value);
        covered.set(id, r.body);
      }
      return r.body;
    }
    return { error: (r.body && r.body.error) || ('HTTP ' + r.status) };
  }

  async function check(address) {
    if (!isAddress(address)) throw NetError('invalid', 'Not a valid poa1 address');
    var r = await getJson(fetchFn, node + '/api/explorer/address/' + encodeURIComponent(address) + '?sort=new', timeoutMs);
    if (r.status === 503 || r.status === 429 || (r.body && /busy|segments|halted/i.test(String(r.body.error || '')))) {
      throw NetError('busy', 'The ledger is catching up. Retrying shortly.', { retryAfter: (r.body && r.body.retry_after_seconds) || 15 });
    }
    if (!r.ok || !r.body || r.body.error || r.body.balance === undefined) throw NetError('bad', (r.body && r.body.error) || ('Explorer answered HTTP ' + r.status));
    var rows = (r.body.txs || []).slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var ids = [], details = {};
    for (var i = 0; i < rows.length && ids.length < maxDetails; i++) ids.push(rows[i].id);
    var idx = 0;
    async function worker() { while (idx < ids.length) { var id = ids[idx++]; details[id] = await detailFor(id); } }
    var ws = []; for (i = 0; i < Math.min(conc, ids.length); i++) ws.push(worker());
    await Promise.all(ws);
    var out = derive(address, r.body, details);
    out.truncated = rows.length > ids.length;
    return out;
  }

  // Track one txid (for example a transfer you just sent) even before it shows in the address list.
  async function watchTx(txid) {
    if (!/^[0-9a-f]{64}$/.test(String(txid || ''))) throw NetError('invalid', 'A txid is 64 hex characters');
    var res = await Promise.all([
      getJson(fetchFn, node + '/api/receipt/' + txid, timeoutMs),
      getJson(fetchFn, node + '/api/explorer/tx/' + txid, timeoutMs)
    ]);
    var rc = res[0], ex = res[1];
    var receipt = rc.ok && rc.body && !rc.body.error ? rc.body : null;
    var detail = ex.ok && ex.body && !ex.body.error ? ex.body : null;
    var rstat = receipt ? String(receipt.status || '').toLowerCase() : '';
    var state;
    if (detail) state = txStatus(detail, detail).state; // 'final' or 'pending'
    else if (/reject|invalid|fail|drop|expire/.test(rstat)) state = 'failed';
    else if (receipt) state = rstat === 'included' ? 'included' : 'pending';
    else state = 'notfound';
    return {
      id: txid, state: state, receiptStatus: rstat || null, height: receipt && receipt.height != null ? receipt.height : null,
      atts: detail ? Number(detail.atts) || 0 : null,
      checkpointHeight: detail && detail.checkpointed ? detail.checkpointed.height : null,
      type: detail ? detail.type : null, from: detail ? detail.from_addr : null, to: detail ? detail.to_addr : null,
      amount: detail ? detail.amount : null, memo: detail && typeof detail.memo === 'string' ? detail.memo : null,
      reason: !detail && !receipt ? ((rc.body && rc.body.error) || (ex.body && ex.body.error) || null) : null
    };
  }
  return { check: check, watchTx: watchTx };
}


export { K, b58dec, isAddress, looksLikePrivkey, toMicros, fromMicros, txStatus, derive, makeChecker };

/** One shared checker per process with a short per-address cache, for the HTTP route and the MCP tool. */
const shared = { checker: null, cache: new Map(), inflight: new Map() };
export async function walletBalance(address, { fetchImpl = globalThis.fetch, node = process.env.POA_MINEPOA_NODE || 'https://minepoa.com', maxAgeMs = 5000 } = {}) {
  if (!shared.checker || shared.node !== node || shared.fetchImpl !== fetchImpl) {
    shared.checker = makeChecker({ fetch: fetchImpl, node, timeoutMs: 10000 });
    shared.node = node; shared.fetchImpl = fetchImpl; shared.cache.clear();
  }
  const hit = shared.cache.get(address);
  if (hit && Date.now() - hit.at < maxAgeMs) return { ...hit.value, cached: true };
  if (shared.inflight.has(address)) return shared.inflight.get(address);
  const p = shared.checker.check(address).then((value) => {
    const out = { ...value, checkedAt: new Date().toISOString(), source: `${node}/api/explorer` };
    shared.cache.set(address, { at: Date.now(), value: out });
    if (shared.cache.size > 500) shared.cache.delete(shared.cache.keys().next().value);
    return out;
  }).finally(() => shared.inflight.delete(address));
  shared.inflight.set(address, p);
  return p;
}
