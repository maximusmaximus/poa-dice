// @ts-nocheck
/**
 * fix/settle-once-lp-nav. Reproduces three things seen on poadice.grok.me on 2026-10-25 after a real
 * 1 POA roll (bet e3888b26…, roll under 95.00):
 *   1. The stored result said roll 76.96 but the on-chain payout note said roll=93.96: two server
 *      instances, each with its own in-memory vault copy (own seed / nonce), both settled the bet.
 *   2. The LP position was valued at 9.960359 POA while the bank NAV was 9.956395 (virtual-offset math).
 *   3. /api/stream delivered every event twice.
 * Everything runs against the local mock minepoa; nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createDiceServer, sseFrame } from '../src/server.mjs';
import { BankrollEngine } from '../src/bankroll-engine.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros } from '../src/crypto-poa.mjs';
import { verifyRoll, generateServerSeed } from '../src/provably-fair.mjs';
import { createMemoryStore, createClaimTable, createFileStore, createPostgresStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-once-${t}-`));
const BANK_TARGET = 9500;

async function boot({ mock, bank, store, tag }) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey },
    storeEnv: {},
    settlementStore: store,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  return { app, url: info.url, close: () => app.close() };
}

function directTx(mock, wallet, to, amount, memo) {
  return buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents() });
}

/** Tick both instances at the same time, several rounds (what two serverless instances do). */
async function settleBoth(a, b, rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await Promise.all([a.app.settlement.tick(), b.app.settlement.tick()]);
    await new Promise((r) => setTimeout(r, 20));
  }
  await Promise.all([a.app.settlement.idle(), b.app.settlement.idle()]);
}

/** A store "without claims" = the pre-fix behaviour (each instance decides alone). */
function legacyStore(initial) {
  const s = createMemoryStore(initial);
  return { kind: s.kind, location: s.location, durable: true, load: s.load, save: s.save };
}

/**
 * Two instances share the vault: B's copy of the document was taken before the seed/nonce state
 * converged (B booted blank and generated its own seed, and B counts one extra bet for the player).
 */
async function twoInstances({ mock, bank, player, withClaims }) {
  const claims = createClaimTable();
  const storeA = withClaims ? createMemoryStore(null, { claims }) : legacyStore(null);
  const a = await boot({ mock, bank, store: storeA, tag: 'a' });
  const dep = directTx(mock, player, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 }));
  mock.directSubmit(dep.body);
  for (let i = 0; i < 4; i++) await a.app.settlement.tick();
  await a.app.settlement.flush();
  assert.equal(a.app.engine.bankNavMicros, toMicros('20.000000'));
  const docB = JSON.parse(JSON.stringify(storeA.load()));
  docB.engine.seedState.currentSeed = generateServerSeed(); // B's own seed
  docB.engine.seedState.nextSeed = generateServerSeed();
  docB.engine.playerNonces = [[player.address, 1]]; // B's own nonce counter
  const storeB = withClaims ? createMemoryStore(docB, { claims }) : legacyStore(docB);
  const b = await boot({ mock, bank, store: storeB, tag: 'b' });
  return { a, b };
}

function betOnLedger(mock, player, bank, seed) {
  const bet = directTx(mock, player, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: BANK_TARGET, clientSeed: seed }));
  mock.directSubmit(bet.body);
  return bet.id;
}

test('root cause: without an atomic claim two instances roll the same bet differently (76.96 vs 93.96)', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  const { a, b } = await twoInstances({ mock, bank, player, withClaims: false });
  try {
    const id = betOnLedger(mock, player, bank, 'legacy-seed');
    await settleBoth(a, b);
    const ra = a.app.engine.processedTxids.get(id);
    const rb = b.app.engine.processedTxids.get(id);
    assert.ok(ra && rb, 'both instances settled the bet');
    if (ra.recovered || rb.recovered) {
      // Second line of defence (reconcile PR): an instance that only sees the bet after the other one
      // already paid it books that on-chain payout (memo roll, unverified) instead of rolling again.
      const rec = ra.recovered ? ra : rb;
      assert.equal(rec.rollSource, 'payout-memo');
      assert.equal(rec.rollVerified, false);
      return;
    }
    assert.notEqual(ra.provablyFair.serverSeedHash, rb.provablyFair.serverSeedHash, 'different seeds');
    assert.notEqual(ra.provablyFair.nonce, rb.provablyFair.nonce, 'different nonces');
    assert.notEqual(ra.provablyFair.hmacHex, rb.provablyFair.hmacHex, 'so the HMAC (and the roll) differ');
  } finally {
    await a.close();
    await b.close();
    await mock.close();
  }
});

test('two instances settling at once: one ticket, one result, one payout, and the payout note matches', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  const { a, b } = await twoInstances({ mock, bank, player, withClaims: true });
  try {
    // B adopts A's committed seed before it can roll anything
    await b.app.settlement.tick();
    assert.equal(b.app.engine.seedManager.currentSeedHash, a.app.engine.seedManager.currentSeedHash, 'one commitment for all instances');
    const commitment = a.app.engine.seedManager.currentSeedHash;

    let won = null;
    for (let i = 0; i < 6 && !won; i++) {
      const id = betOnLedger(mock, player, bank, `once-${i}`);
      await settleBoth(a, b);
      const ra = a.app.engine.processedTxids.get(id);
      const rb = b.app.engine.processedTxids.get(id);
      assert.ok(ra && rb, 'both instances booked the bet');
      for (const k of ['rollBps', 'rollDisplay', 'won', 'payoutPoa']) assert.equal(ra[k], rb[k], `${k} identical on both instances`);
      assert.deepEqual(ra.provablyFair, rb.provablyFair, 'same nonce, seed epoch, seed hash and HMAC');
      assert.equal(ra.provablyFair.serverSeedHash, commitment, 'rolled with the published commitment');
      // the claimed roll verifies against the committed seed
      const v = verifyRoll({
        serverSeed: a.app.engine.seedManager.currentSeed,
        serverSeedHash: commitment,
        clientSeed: ra.provablyFair.clientSeed,
        nonce: ra.provablyFair.nonce,
        betTxid: id,
        targetBps: BANK_TARGET,
        direction: 'under'
      });
      assert.equal(v.seedHashMatches, true);
      assert.equal(v.rollBps, ra.rollBps, 'recomputed roll matches');
      assert.equal(v.won, ra.won);
      if (ra.won) won = { id, ra };
    }
    assert.ok(won, 'a 95% bet won within 6 tries');
    const payouts = mock.transfersFrom(bank.address).filter((t) => String(t.body.memo).startsWith(`DICE1:WIN:${won.id.slice(0, 16)}`));
    assert.equal(payouts.length, 1, 'exactly one payout on the ledger');
    assert.match(payouts[0].body.memo, new RegExp(`:roll=${won.ra.rollDisplay.replace('.', '\\.')}:`), 'payout note carries the stored roll');
    assert.equal(payouts[0].body.amount, won.ra.payoutPoa);
    // no other bank transfer at all besides win payouts (no duplicate of any order)
    const memos = mock.transfersFrom(bank.address).map((t) => t.body.memo.split(':ord=')[1]);
    assert.equal(new Set(memos).size, memos.length, 'one transfer per order');
  } finally {
    await a.close();
    await b.close();
    await mock.close();
  }
});

test('claim adapters: memory, file (O_EXCL) and postgres (ON CONFLICT DO NOTHING) are first-writer-wins', async () => {
  const claims = createClaimTable();
  const m1 = createMemoryStore(null, { claims });
  const m2 = createMemoryStore(null, { claims });
  assert.deepEqual(m1.claim('bet:x', { r: 1 }), { claimed: true, value: { r: 1 } });
  assert.deepEqual(m2.claim('bet:x', { r: 2 }), { claimed: false, value: { r: 1 } });

  const dir = tmp('fileclaim');
  const f1 = createFileStore(dir);
  const f2 = createFileStore(dir);
  assert.equal(f1.claim('bet:y', { r: 1 }).claimed, true);
  assert.deepEqual(f2.claim('bet:y', { r: 2 }), { claimed: false, value: { r: 1 } });

  // postgres adapter against a fake query fn implementing the two tables' semantics
  const rows = new Map();
  const docs = new Map();
  const query = async (sql, params) => {
    if (/^CREATE TABLE/.test(sql)) return { rows: [] };
    if (/INSERT INTO poa_dice_claims/.test(sql)) {
      if (rows.has(params[0])) return { rows: [] };
      rows.set(params[0], JSON.parse(params[1]));
      return { rows: [{ value: JSON.parse(params[1]) }] };
    }
    if (/SELECT value FROM poa_dice_claims/.test(sql)) return { rows: rows.has(params[0]) ? [{ value: rows.get(params[0]) }] : [] };
    if (/INSERT INTO poa_dice_docs/.test(sql)) {
      docs.set(params[0], JSON.parse(params[1]));
      return { rows: [] };
    }
    if (/SELECT doc FROM poa_dice_docs/.test(sql)) return { rows: docs.has(params[0]) ? [{ doc: docs.get(params[0]) }] : [] };
    throw new Error(`unexpected sql ${sql}`);
  };
  const p1 = createPostgresStore({ key: 'k', query });
  const p2 = createPostgresStore({ key: 'k', query });
  const [r1, r2] = await Promise.all([p1.claim('bet:z', { r: 1 }), p2.claim('bet:z', { r: 2 })]);
  assert.equal([r1, r2].filter((r) => r.claimed).length, 1, 'exactly one winner');
  assert.deepEqual(r1.value, r2.value, 'both see the same value');
  await p1.save({ version: 1, x: 1 });
  assert.deepEqual(await p2.load(), { version: 1, x: 1 });
});

test('LP valuation: share price and position value are exactly NAV / total shares, rounded down', () => {
  const e = new BankrollEngine({ dataDir: tmp('lp') });
  const max = genKeypair();
  e.applyDeposit({ txid: 'd'.repeat(64), address: max.address, amountPoa: '10.000000', lockEpochs: 0 });
  // live numbers after the 1 POA roll: NAV fell from 10 to 9.956395
  e.bankNavMicros = toMicros('9.956395');
  const pos = e.getLpPosition(max.address);
  assert.equal(pos.currentValuePoa, '9.956395', 'sole LP is worth exactly the NAV (was 9.960359)');
  const s = e.getStateSummary(max.address);
  assert.equal(s.bankroll.sharePricePerUnitPoa, '0.995639', 'price = 9.956395 / 10, rounded down');
  const q = e.quoteWithdraw({ address: max.address, mode: 'ALL' });
  assert.ok(toMicros(q.grossPayoutPoa ?? q.grossValuePoa ?? pos.currentValuePoa) <= e.bankNavMicros, 'withdrawal never exceeds NAV');

  // several LPs: values sum to <= NAV and each is floor(NAV * shares / total)
  const b = genKeypair();
  const c = genKeypair();
  e.applyDeposit({ txid: 'e'.repeat(64), address: b.address, amountPoa: '13.333333', lockEpochs: 0 });
  e.applyDeposit({ txid: 'f'.repeat(64), address: c.address, amountPoa: '27.000001', lockEpochs: 0 });
  e.bankNavMicros -= 1234567n;
  let sum = 0n;
  for (const addr of [max.address, b.address, c.address]) {
    const p = e.lpPositions.get(addr);
    const v = toMicros(e.getLpPosition(addr).currentValuePoa);
    assert.equal(v, (p.shares * e.bankNavMicros) / e.totalShares);
    sum += v;
  }
  assert.ok(sum <= e.bankNavMicros, `sum ${sum} <= NAV ${e.bankNavMicros}`);
  assert.ok(e.bankNavMicros - sum < 3n, 'at most 1 micro of rounding per LP');
  // a deposit at a sub-1.0 price does not dilute existing LPs
  const before = toMicros(e.getLpPosition(max.address).currentValuePoa);
  e.applyDeposit({ txid: '1'.repeat(64), address: genKeypair().address, amountPoa: '50.000000', lockEpochs: 0 });
  assert.ok(toMicros(e.getLpPosition(max.address).currentValuePoa) >= before, 'existing LP not diluted by a new deposit');
});

function collectSse(url) {
  const frames = [];
  let buf = '';
  let req;
  const ready = new Promise((resolve) => {
    req = http.get(`${url}/api/stream`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          frames.push(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
        resolve();
      });
    });
  });
  return { frames, ready, close: () => req.destroy() };
}

test('SSE: each event is delivered exactly once (one frame per id, double publish dropped)', async () => {
  assert.equal(sseFrame({ id: 'evt_1', type: 't', payload: {} }), 'id: evt_1\ndata: {"id":"evt_1","type":"t","payload":{}}\n\n');
  const app = createDiceServer({ dataDir: tmp('sse'), watcherMode: 'simulated', requireChain: false });
  const info = await app.listen(0, '127.0.0.1');
  const sse = collectSse(info.url);
  try {
    await sse.ready;
    const evt = app.engine._emit('chat.message', { text: 'hello' });
    for (const fn of app.engine.eventListeners) fn(evt); // the same event published a second time
    app.engine._emit('bank.deposit', { n: 2 });
    await new Promise((r) => setTimeout(r, 100));
    const data = sse.frames.filter((f) => f.includes('data:')).map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data:')).slice(5)));
    const ids = data.filter((d) => d.id).map((d) => d.id);
    assert.equal(ids.length, 2, `two events, two frames (got ${ids.length})`);
    assert.equal(new Set(ids).size, ids.length, 'no id delivered twice');
    assert.ok(sse.frames.every((f) => !f.startsWith('event:')), 'no extra named copy');
    assert.ok(sse.frames.filter((f) => f.startsWith('id: ')).length === 2, 'id line lets browsers resume');
  } finally {
    sse.close();
    await app.close();
  }
});
