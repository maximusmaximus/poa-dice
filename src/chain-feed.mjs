// @ts-nocheck
/**
 * Live minepoa.com balances. The dice vault never invents POA.
 * Player spendable = checkpoint balance + final incoming the checkpoint does not cover yet
 * - uncovered outgoing - local debits not listed yet - in-flight reservations (playerSpendableMicros).
 */
import fs from 'node:fs';
import path from 'node:path';
import { toMicros, fromMicros } from './crypto-poa.mjs';

const DEBITS = 'chain-debits.json';

export function loadDebits(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, DEBITS), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveDebits(dataDir, debits) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, DEBITS);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(debits, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Read-only hosts keep the debit list in memory only.
  }
}

export async function fetchExplorerAddress(nodeUrl, address, fetchImpl = globalThis.fetch) {
  const root = String(nodeUrl || 'https://minepoa.com').replace(/\/+$/, '');
  const url = `${root}/api/explorer/address/${encodeURIComponent(address)}?sort=new`;
  const resp = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'poa-dice/1.0' },
    signal: AbortSignal.timeout(12000)
  });
  if (!resp.ok) {
    throw new Error(`Explorer ${resp.status} for ${address}`);
  }
  const data = await resp.json();
  // Fail closed: a 200 that carries an error ("not in segments", "origin busy") or no balance is not a balance.
  if (!data || typeof data !== 'object' || data.error || typeof data.balance !== 'string') {
    throw new Error(`Explorer has no balance for ${address}${data?.error ? `: ${String(data.error).slice(0, 120)}` : ''}`);
  }
  const balance = data.balance;
  const txs = Array.isArray(data.txs)
    ? data.txs.map((t) => ({ ...normalizeExplorerTx(t), atts: Number(t?.atts || 0), final: t?.final === true || t?.final === 1 || t?.final === '1' }))
    : [];
  return {
    address,
    balance,
    balanceMicros: toMicros(balance || '0').toString(),
    checkpoint: data.checkpoint_height ?? data.balance_as_of?.checkpoint_height ?? null,
    asOf: data.as_of || null,
    txs
  };
}

/** GET /api/explorer/tx/<id>. Never throws: an unreachable or erroring read node gives {error}. */
export async function fetchExplorerTx(nodeUrl, txid, fetchImpl = globalThis.fetch) {
  const root = String(nodeUrl || 'https://minepoa.com').replace(/\/+$/, '');
  try {
    const resp = await fetchImpl(`${root}/api/explorer/tx/${encodeURIComponent(txid)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'poa-dice/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok || !body || body.error) return { error: (body && body.error) || `HTTP ${resp.status}` };
    return body;
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

/** True when the explorer says a checkpoint covers this tx (it is already in the checkpoint balance). */
export function isCheckpointCovered(detail) {
  return Boolean(detail && !detail.error && (detail.checkpointed || detail.finality?.via === 'checkpoint'));
}

/**
 * Tx details for an address row, newest first, so we know which txs the checkpoint balance
 * does not cover yet. Coverage is permanent, so covered details are cached across calls.
 * Stops after `coveredStreak` covered txs in a row: everything older is covered too.
 * Rows it did not look at stay without a detail (treated conservatively by playerSpendableMicros).
 */
export async function loadTxDetails(row, fetchTx, { maxDetails = 40, coveredStreak = 3, cache = null } = {}) {
  const details = {};
  const rows = (row?.txs || []).filter((t) => t && t.id).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  let streak = 0;
  let looked = 0;
  for (const t of rows) {
    if (streak >= coveredStreak) {
      details[t.id] = { assumedCovered: true };
      continue;
    }
    if (looked >= maxDetails) break;
    let d = cache?.get(t.id);
    if (!d) {
      looked += 1;
      d = await fetchTx(t.id);
      if (cache && isCheckpointCovered(d)) cache.set(t.id, d);
    }
    details[t.id] = d;
    streak = isCheckpointCovered(d) ? streak + 1 : 0;
  }
  return details;
}

/**
 * Player spendable balance, conservative (the bank's view in chain-settlement is similar):
 *   checkpoint balance
 *   + incoming transfers the checkpoint does not cover yet, only when the explorer says FINAL
 *   - every outgoing transfer the checkpoint does not cover (pending, final or unknown)
 *   - signed actions the server booked that the explorer does not list yet (debits)
 *   - in-flight reservations (pendingMicros)
 * Pending incoming, and incoming whose detail could not be read ("not in segments", busy), are
 * never counted. Outgoing is subtracted unless a checkpoint provably covers it.
 */
export function playerSpendableMicros({ address, row, details = {}, debits = [], pendingMicros = 0n }) {
  let checkpointMicros;
  try {
    checkpointMicros = toMicros(row?.balance ?? '');
  } catch {
    throw new Error(`Explorer has no balance for ${address}`);
  }
  let finalIn = 0n;
  let out = 0n;
  const listed = new Set();
  for (const t of row?.txs || []) {
    if (!t || !t.id) continue;
    listed.add(t.id);
    if (t.to === address && t.from === address) continue;
    let amt = 0n;
    try {
      amt = toMicros(t.amount || '0');
    } catch {
      amt = 0n;
    }
    if (amt <= 0n) continue;
    const d = details[t.id];
    if (isCheckpointCovered(d) || d?.assumedCovered) continue; // already in the checkpoint balance
    if (t.to === address) {
      const ok = d && !d.error && (d.final === true || Number(d.final) === 1);
      if (ok) finalIn += amt;
    } else if (t.from === address) {
      out += amt;
    }
  }
  const unlisted = (debits || [])
    .filter((x) => x && x.address === address && !listed.has(x.txid))
    .reduce((sum, x) => sum + BigInt(x.amountMicros || '0'), 0n);
  const pending = BigInt(pendingMicros || 0n);
  const have = checkpointMicros + finalIn - out - unlisted - pending;
  return {
    spendableMicros: have > 0n ? have : 0n,
    checkpointMicros,
    uncoveredFinalInMicros: finalIn,
    uncoveredOutMicros: out,
    unlistedDebitMicros: unlisted,
    pendingMicros: pending
  };
}

export function normalizeExplorerTx(tx) {
  if (!tx || typeof tx !== 'object') return null;
  return {
    id: tx.id || tx.txid || null,
    type: tx.type || '',
    from: tx.from || tx.from_addr || '',
    to: tx.to || tx.to_addr || '',
    amount: tx.amount || '0',
    memo: tx.memo || '',
    ts: tx.ts || null
  };
}

export function spendableMicros(balance, debits, address) {
  let bal = 0n;
  try {
    bal = toMicros(balance || '0');
  } catch {
    bal = 0n;
  }
  const spent = (debits || [])
    .filter((d) => d && d.address === address)
    .reduce((sum, d) => sum + BigInt(d.amountMicros || '0'), 0n);
  return bal > spent ? bal - spent : 0n;
}

export function dropConfirmedDebits(debits, seenTxids) {
  const seen = seenTxids instanceof Set ? seenTxids : new Set(seenTxids || []);
  return (debits || []).filter((d) => d && !seen.has(d.txid));
}

export function rememberDebit(debits, entry) {
  const next = Array.isArray(debits) ? debits.slice() : [];
  if (!next.some((d) => d.txid === entry.txid)) next.push(entry);
  return next;
}

export function formatMicros(micros) {
  return fromMicros(typeof micros === 'bigint' ? micros : BigInt(micros || '0'));
}
