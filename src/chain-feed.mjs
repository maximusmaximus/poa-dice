// @ts-nocheck
/**
 * Live minepoa.com balances. The dice vault never invents POA.
 * Spendable = chain balance minus local debits for signed actions not yet seen on chain.
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
  const balance = typeof data.balance === 'string' ? data.balance : '0.000000';
  const txs = Array.isArray(data.txs) ? data.txs.map(normalizeExplorerTx) : [];
  return {
    address,
    balance,
    balanceMicros: toMicros(balance || '0').toString(),
    checkpoint: data.checkpoint_height ?? data.balance_as_of?.checkpoint_height ?? null,
    asOf: data.as_of || null,
    txs
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
