/**
 * The bank's full transfer history, kept in the vault document so the balance never loses old txs.
 *
 * minepoa's /api/explorer/address/<a> lists only an address's newest 100 transfers (limit, page, offset,
 * sort and before are ignored). Seen live on 2026-10-27: once the bank passed 100 transfers, its three
 * oldest (two deposits and a payout) fell off the list, the balance built from that list dropped by
 * 10.999999 POA and the site went into SOLVENCY_HOLD with nothing actually missing.
 *
 * Every bank transfer the site has seen is recorded here by txid (deduplicated, never removed), and the
 * balance is summed over that record. The record is "complete" (it holds every transfer up to the newest
 * one in it) when it was either:
 *   - built from a minepoa list shorter than the cap (that list is the whole history), or
 *   - backfilled from POAScan's full address history (all pages, no nonce gap) that overlaps minepoa's list,
 * and every later minepoa list overlaps it (a list with no tx in common could hide a gap).
 * When completeness cannot be shown (POAScan busy, 429/5xx/timeout, a gap, or conflicting amounts) the
 * balance is not trusted: bets stay refused and the hold stays. It never fails open.
 *
 * Counting is the same as before: inbound transfers count once final; outbound transfers count as soon
 * as they are listed (a lower bound on what the bank can spend).
 */
import { toMicros } from './crypto-poa.mjs';

/** minepoa's address page never lists more than this many transfers. */
export const MINEPOA_ADDRESS_CAP = 100;

export function emptyBankHistory() {
  return {
    v: 2,
    complete: false,
    completeAt: null,
    completeVia: null,
    checkpoint: { finalInMicros: '0', outAllMicros: '0', count: 0 },
    recentCompactedIds: [],
    txs: {}
  };
}

/** The history record in a vault state document (created on first use). */
export function bankHistoryOf(state) {
  if (!state.bankHistory || typeof state.bankHistory !== 'object' || !state.bankHistory.txs) {
    state.bankHistory = emptyBankHistory();
  } else {
    if (!state.bankHistory.checkpoint) {
      state.bankHistory.checkpoint = { finalInMicros: '0', outAllMicros: '0', count: 0 };
    }
    if (!Array.isArray(state.bankHistory.recentCompactedIds)) {
      state.bankHistory.recentCompactedIds = [];
    }
  }
  return state.bankHistory;
}

function micros(x) {
  try {
    return toMicros(x || '0');
  } catch {
    return null;
  }
}

/**
 * Merge transfers into the record. Only transfers to or from the bank count; self-transfers are skipped.
 * An entry is never removed, its amount and direction never change, and `final` only goes false -> true.
 * Returns { added, changed, conflicts } (conflicts: same txid, different amount or direction).
 */
export function mergeBankTxs(hist, txs, bankAddress, source) {
  let added = 0;
  let changed = 0;
  const conflicts = [];
  const compactedSet = new Set(hist.recentCompactedIds || []);
  for (const t of txs || []) {
    if (!t || !t.id) continue;
    if (t.type && t.type !== 'transfer') continue;
    const id = String(t.id).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) continue;
    if (t.from === bankAddress && t.to === bankAddress) continue;
    const d = t.to === bankAddress ? 'in' : t.from === bankAddress ? 'out' : null;
    if (!d) continue;
    const m = micros(t.amount);
    if (m === null) continue;
    if (compactedSet.has(id)) continue;
    const prev = hist.txs[id];
    if (prev) {
      if (prev.d !== d || micros(prev.a) !== m) {
        conflicts.push(id);
        continue;
      }
      if (t.final && !prev.f) {
        prev.f = true;
        changed += 1;
      }
      continue;
    }
    hist.txs[id] = { d, a: String(t.amount), f: Boolean(t.final), ts: t.ts ?? null, src: source };
    added += 1;
  }
  return { added, changed, conflicts };
}

/** Sums over the whole record (checkpoint + active window): final inbound, all outbound, and active txids. */
export function bankHistoryTotals(hist) {
  const cp = hist?.checkpoint || { finalInMicros: '0', outAllMicros: '0', count: 0 };
  let finalIn = BigInt(cp.finalInMicros || '0');
  let outAll = BigInt(cp.outAllMicros || '0');
  const ids = new Set(hist?.recentCompactedIds || []);
  let activeCount = 0;
  for (const [id, e] of Object.entries(hist?.txs || {})) {
    ids.add(id);
    activeCount += 1;
    const m = micros(e.a) ?? 0n;
    if (e.d === 'in') {
      if (e.f) finalIn += m;
    } else if (e.d === 'out') outAll += m;
  }
  return { finalIn, outAll, ids, count: Number(cp.count || 0) + activeCount };
}

/**
 * Fold finalized transfers beyond `keepRecent` into `hist.checkpoint` so the hot vault JSON remains O(1)
 * in size while preserving exact lifetime `finalIn`, `outAll`, and `count`. Unfinalized entries are never compacted.
 */
export function compactBankHistory(hist, { keepRecent = 2000, guardWindow = 500 } = {}) {
  if (!hist || !hist.txs) return 0;
  const entries = Object.entries(hist.txs);
  if (entries.length <= keepRecent) return 0;
  // Sort oldest-first by timestamp (null timestamps stay newest so they aren't evicted prematurely)
  entries.sort((a, b) => {
    const ta = a[1].ts === null || a[1].ts === undefined ? Number.MAX_SAFE_INTEGER : Number(a[1].ts);
    const tb = b[1].ts === null || b[1].ts === undefined ? Number.MAX_SAFE_INTEGER : Number(b[1].ts);
    return ta - tb;
  });
  const targetFold = entries.length - keepRecent;
  const cp = hist.checkpoint || (hist.checkpoint = { finalInMicros: '0', outAllMicros: '0', count: 0 });
  let cpIn = BigInt(cp.finalInMicros || '0');
  let cpOut = BigInt(cp.outAllMicros || '0');
  let cpCount = Number(cp.count || 0);
  const foldedIds = [];

  for (const [id, e] of entries) {
    if (foldedIds.length >= targetFold) break;
    if (!e.f) continue; // never fold non-final entries
    const m = micros(e.a) ?? 0n;
    if (e.d === 'in') cpIn += m;
    else if (e.d === 'out') cpOut += m;
    cpCount += 1;
    foldedIds.push(id);
    delete hist.txs[id];
  }

  if (foldedIds.length > 0) {
    cp.finalInMicros = cpIn.toString();
    cp.outAllMicros = cpOut.toString();
    cp.count = cpCount;
    const guard = [...(hist.recentCompactedIds || []), ...foldedIds];
    hist.recentCompactedIds = guard.slice(-guardWindow);
  }
  return foldedIds.length;
}

/**
 * Check a POAScan address history before it is used to complete the record. Returns null when it can be
 * used, or the reason it cannot. `listing` is minepoa's (capped) list: the two must have a tx in common,
 * or there could be a gap between POAScan's newest and minepoa's oldest.
 */
export function poascanHistoryProblem(rows, listing, bankAddress) {
  if (!Array.isArray(rows)) return 'POAScan returned no history';
  const cov = rows.coverage;
  if (cov && Number(cov.nonce_gap) > 0) return `POAScan reports a nonce gap of ${cov.nonce_gap} in the bank's sent txs (its archive missed some)`;
  if (cov && cov.complete === false) return 'POAScan reports the bank history as incomplete';
  const ids = new Set(rows.filter((t) => t && t.id && (t.from === bankAddress || t.to === bankAddress)).map((t) => String(t.id).toLowerCase()));
  if (!ids.size) return 'POAScan has no transfers for the bank';
  if ((listing || []).length && !(listing || []).some((t) => t && ids.has(String(t.id).toLowerCase()))) return 'POAScan history and the minepoa list have no transfer in common (possible gap)';
  return null;
}
