// @ts-nocheck
/**
 * Player spendable balance vs minepoa's lagging checkpoint balance:
 *  - final incoming the checkpoint does not cover yet counts; pending or unreadable incoming never does;
 *  - outgoing the checkpoint does not cover is subtracted whether pending, final or unknown;
 *  - server debits are subtracted only until the explorer lists the tx (no double count);
 *  - explorer errors ("not in segments", busy) fail closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchExplorerAddress, isCheckpointCovered, loadTxDetails, playerSpendableMicros } from '../src/chain-feed.mjs';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, toMicros, fromMicros } from '../src/crypto-poa.mjs';

const ME = genKeypair().address;
const OTHER = genKeypair().address;
const COVERED = { final: 1, checkpointed: { height: 30618 } };
const spend = (args) => fromMicros(playerSpendableMicros({ address: ME, ...args }).spendableMicros);
const tx = (id, from, to, amount, ts = 1) => ({ id, from, to, amount, ts });

test('checkpoint lag: final incoming not yet covered counts (fresh airdrop wallet)', () => {
  const row = { balance: '0.000000', txs: [tx('a', OTHER, ME, '100.000000')] };
  assert.equal(spend({ row, details: { a: { final: 1, atts: 40 } } }), '100.000000');
  // the same tx once covered is already in the checkpoint balance: not counted twice
  assert.equal(spend({ row: { ...row, balance: '100.000000' }, details: { a: COVERED } }), '100.000000');
});

test('pending or unreadable incoming is never counted', () => {
  const row = { balance: '5.000000', txs: [tx('a', OTHER, ME, '100.000000')] };
  assert.equal(spend({ row, details: { a: { final: 0, atts: 2 } } }), '5.000000');
  assert.equal(spend({ row, details: { a: { error: 'not in segments' } } }), '5.000000');
  assert.equal(spend({ row, details: {} }), '5.000000');
});

test('outgoing not covered is subtracted whether pending, final or unknown', () => {
  const row = { balance: '50.000000', txs: [tx('in', OTHER, ME, '100.000000', 1), tx('o1', ME, OTHER, '10.000000', 2), tx('o2', ME, OTHER, '5.000000', 3), tx('o3', ME, OTHER, '1.000000', 4), tx('o4', ME, OTHER, '2.000000', 0)] };
  const details = { in: { final: 1 }, o1: { final: 1 }, o2: { final: 0, atts: 1 }, o3: { error: 'origin busy' }, o4: COVERED };
  // 50 + 100 - 10 - 5 - 1 (o4 is covered: already in the checkpoint balance)
  assert.equal(spend({ row, details }), '134.000000');
  const r = playerSpendableMicros({ address: ME, row, details });
  assert.equal(fromMicros(r.uncoveredOutMicros), '16.000000');
  assert.equal(fromMicros(r.uncoveredFinalInMicros), '100.000000');
});

test('server debits count until the explorer lists the tx; reservations are subtracted; never below 0', () => {
  const debits = [{ txid: 'bet1', address: ME, amountMicros: toMicros('1.000000').toString() }, { txid: 'x', address: OTHER, amountMicros: '999000000' }];
  const row = { balance: '0.000000', txs: [tx('a', OTHER, ME, '100.000000')] };
  assert.equal(spend({ row, details: { a: { final: 1 } }, debits }), '99.000000');
  const listed = { ...row, txs: [...row.txs, tx('bet1', ME, OTHER, '1.000000', 2)] };
  assert.equal(spend({ row: listed, details: { a: { final: 1 }, bet1: { final: 0 } }, debits }), '99.000000', 'listed bet is not subtracted twice');
  assert.equal(spend({ row, details: { a: { final: 1 } }, debits, pendingMicros: toMicros('4.000000') }), '95.000000');
  assert.equal(spend({ row: { balance: '0.000000', txs: [tx('o', ME, OTHER, '3.000000')] }, details: {} }), '0.000000');
});

test('loadTxDetails: newest first, caches coverage, stops after a covered streak', async () => {
  const txs = Array.from({ length: 10 }, (_, i) => tx(`t${i}`, OTHER, ME, '1.000000', 100 - i));
  const seen = [];
  const fetchTx = async (id) => { seen.push(id); return Number(id.slice(1)) >= 2 ? COVERED : { final: 1 }; };
  const cache = new Map();
  const d = await loadTxDetails({ txs }, fetchTx, { cache, coveredStreak: 3 });
  assert.deepEqual(seen, ['t0', 't1', 't2', 't3', 't4']);
  assert.equal(d.t9.assumedCovered, true);
  assert.equal(isCheckpointCovered(d.t2), true);
  seen.length = 0;
  await loadTxDetails({ txs }, fetchTx, { cache, coveredStreak: 3 });
  assert.deepEqual(seen, ['t0', 't1'], 'covered details come from the cache');
});

test('fetchExplorerAddress fails closed on an error body or a missing balance', async () => {
  const mk = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
  await assert.rejects(fetchExplorerAddress('https://x', ME, mk({ error: 'not in segments' })), /not in segments/);
  await assert.rejects(fetchExplorerAddress('https://x', ME, mk({ txs: [] })), /no balance/);
  await assert.rejects(fetchExplorerAddress('https://x', ME, mk({ error: 'origin busy' }, 503)), /503/);
  const ok = await fetchExplorerAddress('https://x', ME, mk({ balance: '0.000000', txs: [{ id: 'a', from_addr: OTHER, to_addr: ME, amount: '100.000000', final: 1, atts: 40 }] }));
  assert.equal(ok.txs[0].final, true);
  assert.equal(ok.txs[0].to, ME);
});

test('server: a fresh wallet whose airdrop is final but not checkpointed can quote; explorer errors block', async () => {
  let addrDown = false;
  let txDetail = { final: 1, atts: 40 };
  const bankRow = (address) => ({ address, balance: '100000.000000', txs: [] });
  const app = createDiceServer({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'spendable-')),
    initialBootstrapPoa: '100000.000000',
    requireChain: true,
    chainCacheMs: 0,
    chainFetch: async (address) => {
      if (address !== ME) return bankRow(address);
      if (addrDown) throw new Error('Explorer has no balance: not in segments');
      return { address, balance: '0.000000', txs: [tx('air', OTHER, ME, '100.000000')] };
    },
    chainTxFetch: async () => txDetail
  });
  const info = await app.listen(0, '127.0.0.1');
  const quote = async () => (await (await fetch(`${info.url}/api/quote/batch?count=1&amountPoa=1&targetBps=9000&direction=under&clientSeed=t&address=${ME}`)).json());
  const state = async () => (await (await fetch(`${info.url}/api/state?address=${ME}`)).json());
  try {
    assert.equal((await state()).chain.player.spendable, '100.000000');
    const q = await quote();
    assert.equal(q.valid, true, JSON.stringify(q).slice(0, 300));
    txDetail = { final: 0, atts: 2 };
    assert.equal((await state()).chain.player.spendable, '0.000000', 'pending incoming is not spendable');
    assert.equal((await quote()).code, 'player_insufficient');
    txDetail = { error: 'not in segments' };
    assert.equal((await state()).chain.player.spendable, '0.000000', 'unreadable incoming is not spendable');
    addrDown = true;
    const s = await state();
    assert.notEqual(s.chain?.ok, true, 'explorer error: no chain view');
    assert.equal((await quote()).valid, false, 'explorer error: quote fails closed');
  } finally {
    await (info.close?.() ?? new Promise((r) => app.server.close(r)));
  }
});
