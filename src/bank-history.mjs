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
  return { v: 1, complete: false, completeAt: null, completeVia: null, txs: {} };
}

/** The history record in a vault state document (created on first use). */
export function bankHistoryOf(state) {
  if (!state.bankHistory || typeof state.bankHistory !== 'object' || !state.bankHistory.txs) state.bankHistory = emptyBankHistory();
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

/** Sums over the whole record: final inbound, all outbound, and the set of txids it holds. */
export function bankHistoryTotals(hist) {
  let finalIn = 0n;
  let outAll = 0n;
  const ids = new Set();
  for (const [id, e] of Object.entries(hist.txs || {})) {
    ids.add(id);
    const m = micros(e.a) ?? 0n;
    if (e.d === 'in') {
      if (e.f) finalIn += m;
    } else if (e.d === 'out') outAll += m;
  }
  return { finalIn, outAll, ids, count: ids.size };
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
