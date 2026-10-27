/**
 * Average play time, from the vault's own server-side timestamps (milliseconds, server clock).
 *
 * A play is one dice bet, timed from when this server accepted the signed bet for broadcast
 * (inbound record `submittedAt`) until it is fully settled:
 *   - a loss: when the bet was booked and settled (inbound `bookedAt`);
 *   - a win:  when the bank's payout for that bet was confirmed on the ledger (outbound `confirmedAt`).
 * A win whose payout is not confirmed yet is still in play and is not counted.
 *
 * Left out, because their timestamps do not describe a real play:
 *   - bets this server never accepted itself (found only by a ledger scan, no acceptance record):
 *     their `submittedAt` is the time they were discovered, not submitted;
 *   - bets booked by recovery from an on-chain payout (`recovered`), and wins whose payout was
 *     matched or recovered from the ledger after the fact, or re-paid: their confirmation time is
 *     when the books were repaired, not when the payout landed.
 */
export function computePlayTimes(inbound = {}, outbound = {}) {
  const payoutBySource = new Map();
  for (const o of Object.values(outbound || {})) {
    if (!o || o.kind !== 'BET_WIN_PAYOUT' || !o.sourceTxid) continue;
    // One win has one payout order; keep the confirmed one if there were ever two.
    const prev = payoutBySource.get(o.sourceTxid);
    if (!prev || (o.status === 'CONFIRMED' && prev.status !== 'CONFIRMED')) payoutBySource.set(o.sourceTxid, o);
  }
  const loss = [];
  const win = [];
  let pendingWins = 0;
  let excluded = 0;
  let lastAt = 0;
  let lastMs = null;
  for (const r of Object.values(inbound || {})) {
    if (!r || r.action !== 'BET' || r.status !== 'BOOKED') continue;
    const res = r.result;
    if (!res || res.action !== 'BET_SETTLED') continue; // refunded / not a played roll
    const start = Number(r.submittedAt);
    if (!Number.isFinite(start) || start <= 0) {
      excluded += 1;
      continue;
    }
    if (r.recovered || (r.discoveredBy === 'ledger-scan' && !r.acceptedBy)) {
      excluded += 1;
      continue;
    }
    let end;
    if (res.won) {
      const p = payoutBySource.get(r.txid);
      if (!p || p.status !== 'CONFIRMED') {
        pendingWins += 1;
        continue;
      }
      if (p.matchedFromLedger || p.recoveredFromLedger || p.repay) {
        excluded += 1;
        continue;
      }
      end = Number(p.confirmedAt);
    } else {
      end = Number(r.bookedAt);
    }
    if (!Number.isFinite(end) || end < start) {
      excluded += 1;
      continue;
    }
    const ms = end - start;
    (res.won ? win : loss).push(ms);
    if (end > lastAt) {
      lastAt = end;
      lastMs = ms;
    }
  }
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const secs = (ms) => (ms === null ? null : Math.round(ms / 100) / 10);
  const all = loss.concat(win);
  return {
    window: 'all-time',
    avgPlaySeconds: secs(avg(all)),
    plays: all.length,
    wins: win.length,
    losses: loss.length,
    avgWinSeconds: secs(avg(win)),
    avgLossSeconds: secs(avg(loss)),
    lastPlaySeconds: secs(lastMs),
    lastPlayAt: lastAt ? new Date(lastAt).toISOString() : null,
    winsAwaitingPayout: pendingWins,
    excluded,
    measuredFrom: 'bet accepted by this server (submittedAt)',
    measuredTo: 'loss: bet settled (bookedAt); win: payout confirmed on the ledger (confirmedAt)'
  };
}
