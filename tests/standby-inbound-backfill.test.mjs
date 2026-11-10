// @ts-nocheck
/**
 * tests/standby-inbound-backfill.test.mjs
 *
 * Regression suite for:
 *  - C-04: Writer directly drains `accepted:<txid>` claims recorded by standbys even if those
 *          transfers have already scrolled past minepoa's capped address/recent-transfer lists.
 *  - C-04 / H-04: Incremental POAScan backfill discovers missed finalized inbound `DICE1:` transfers
 *          and stops paginating early via `stopWhen` once known hot history txids are reached.
 *  - H-02: Unfunded (`0.000000 POA`) sender keypairs are rejected before reserving `poa_dice_reservations`
 *          bankroll coverage, preventing zero-cost coverage-exhaustion DoS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { PoaScanClient } from '../src/poascan-client.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const ADMIN = 'backfill-admin-token';
const CRON = 'backfill-cron-token';

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-backfill-${tag}-`));
}

const ts = () => Math.floor(Date.now() / 1000);
const signedTx = (mock, wallet, to, amount, memo) =>
  buildSignedTransfer({
    wallet,
    to,
    amount,
    memo,
    nonce: mock.nextNonce(wallet.address),
    parents: mock.parents(),
    ts: ts(),
  });

function buildMockIndexer(mock, { pageSize = 4 } = {}) {
  let pagesFetched = 0;
  const fetchImpl = async (urlStr) => {
    const u = new URL(urlStr);
    // PoaScanClient calls /api/v1/address/<address>/txs?limit=200[&cursor=...]
    const m = /^\/api\/v1\/address\/([^/]+)\/txs$/.exec(u.pathname);
    if (!m) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    pagesFetched += 1;
    const addr = decodeURIComponent(m[1]);
    const start = Number(u.searchParams.get('cursor') || 0);
    const all = mock.transfersOf(addr); // newest-first
    const slice = all.slice(start, start + pageSize).map((t) => ({
      id: t.id,
      type: 'transfer',
      from_addr: t.body.from,
      to_addr: t.body.to,
      amount: t.body.amount,
      memo: t.body.memo || '',
      ts: t.body.ts,
      final: t.final ? 1 : 0,
    }));
    const nextCursor = start + pageSize < all.length ? String(start + pageSize) : null;
    return new Response(
      JSON.stringify({
        txs: slice,
        next_cursor: nextCursor,
        coverage: { complete: true, nonce_gap: 0 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  const client = new PoaScanClient({
    baseUrl: 'https://mock.poascan.local',
    fetchImpl,
  });
  return {
    client,
    getPagesFetched: () => pagesFetched,
    resetPagesFetched: () => {
      pagesFetched = 0;
    },
  };
}

async function bootNode({ mock, bank, store, tag, opts = {} }) {
  const dataDir = makeTempDir(tag);
  const app = createDiceServer({
    dataDir,
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: {
      POA_DICE_BANK_PRIVKEY: bank.privkey,
      POA_DICE_BANK_SIGNER: '1',
      POA_DICE_BIND_STORE: bank.address,
    },
    storeEnv: {},
    settlementStore: store,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    adminToken: ADMIN,
    cronSecret: CRON,
    ...opts,
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    await app.settlement.idle();
  };
  const req = async (p, { method = 'GET', body, auth } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const r = await fetch(`${info.url}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  return {
    app,
    s: app.settlement,
    url: info.url,
    settle,
    req,
    close: async () => {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('C-04 & H-04: writer adopts standby accepted:<txid> claims scrolled past address cap, discovers missed POAScan inbound DICE1:, and stops paginating incrementally', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  const externalLp = genKeypair();
  const spammer = genKeypair();
  mock.setBalance(player.address, '200.000000');
  mock.setBalance(externalLp.address, '200.000000');
  mock.setBalance(spammer.address, '200.000000');

  const store = createMemoryStore(null);
  const idx = buildMockIndexer(mock, { pageSize: 4 });

  const leader = await bootNode({
    mock,
    bank,
    store,
    tag: 'leader',
    opts: { indexer: idx.client, addressListCap: 5, historyBackfillEveryMs: 0 },
  });
  const standby = await bootNode({
    mock,
    bank,
    store,
    tag: 'standby',
    opts: { indexer: idx.client, addressListCap: 5, historyBackfillEveryMs: 0 },
  });

  try {
    // Seed bank with 50 POA
    mock.directSubmit(
      signedTx(mock, player, bank.address, '50.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body
    );
    await leader.settle();
    await standby.settle(2);

    // Cap minepoa's address & recent-transfer windows to 5 transfers
    mock.setAddressCap(5);
    mock.setFeedCap(5);

    // 1. Standby accepts a player-signed bet (`accepted:<txid>` saved in shared store)
    const standbyBet = signedTx(
      mock,
      player,
      bank.address,
      '1.000000',
      formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 9500, clientSeed: 'scrolled-standby-bet' })
    );
    const sub = await standby.req('/api/tx/submit', { method: 'POST', body: { tx: standbyBet } });
    assert.equal(sub.status, 202, JSON.stringify(sub.body));

    // Also submit a direct on-chain LP_ADD from externalLp (never sent through /api/tx/submit)
    const missedLpTx = signedTx(
      mock,
      externalLp,
      bank.address,
      '15.000000',
      formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })
    );
    mock.directSubmit(missedLpTx.body);

    // Push 7 plain transfers to the bank so BOTH standbyBet and missedLpTx scroll completely off minepoa's 5-tx cap!
    for (let i = 0; i < 7; i++) {
      mock.directSubmit(signedTx(mock, spammer, bank.address, '0.000001', `plain-note-${i}`).body);
    }

    // Verify neither tx is in minepoa's capped address response
    const cappedAddr = await fetch(`${mock.url}/api/explorer/address/${bank.address}`).then((r) => r.json());
    assert.equal(cappedAddr.txs.length, 5);
    assert.equal(cappedAddr.txs.some((t) => t.id === standbyBet.id || t.id === missedLpTx.id), false);

    // 2. Leader ticks: _drainStandbyAcceptedClaims() adopts standbyBet AND POAScan backfill discovers missedLpTx!
    idx.resetPagesFetched();
    await leader.settle(6);
    const firstBackfillPages = idx.getPagesFetched();
    assert.ok(firstBackfillPages >= 2, `initial backfill read multiple pages (${firstBackfillPages})`);

    assert.equal(leader.s.state.inbound[standbyBet.id]?.status, 'BOOKED', 'standby bet adopted and settled');
    assert.equal(leader.s.state.inbound[missedLpTx.id]?.status, 'BOOKED', 'missed LP_ADD discovered via POAScan backfill and booked');
    assert.ok((leader.app.engine.lpPositions.get(externalLp.address)?.shares || 0n) > 0n, 'externalLp received vault shares');
    assert.equal(leader.s.reconcile.status, 'OK', JSON.stringify(leader.s.reconcile));

    // 3. H-04 incremental stopWhen: record 12 more transfers in hot history, then push a burst of 6 (> addressListCap=5).
    // Because page 2 of POAScan overlaps hotBefore txids, stopWhen halts pagination early instead of reading genesis!
    for (let i = 0; i < 12; i++) {
      mock.directSubmit(signedTx(mock, spammer, bank.address, '0.000001', `known-${i}`).body);
      if ((i + 1) % 3 === 0) await leader.settle(1);
    }
    await leader.settle(2);
    assert.equal(leader.s.bankHistoryView().complete, true);

    for (let i = 0; i < 6; i++) {
      mock.directSubmit(signedTx(mock, spammer, bank.address, '0.000001', `burst-${i}`).body);
    }
    idx.resetPagesFetched();
    await leader.settle(2);
    const incrementalPages = idx.getPagesFetched();
    const totalTransfers = mock.transfersOf(bank.address).length;
    const totalPossiblePages = Math.ceil(totalTransfers / 4);
    assert.ok(
      incrementalPages > 0 && incrementalPages < totalPossiblePages,
      `expected incremental stopWhen to read < ${totalPossiblePages} pages, read ${incrementalPages}`
    );
    assert.equal(leader.s.bankHistoryView().complete, true);
  } finally {
    await standby.close();
    await leader.close();
    await mock.close();
  }
});

test('H-02: unfunded (0 POA) sender keypair is rejected before reserving bankroll coverage', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const fundedLp = genKeypair();
  const unfundedAttacker = genKeypair(); // 0.000000 POA on chain
  mock.setBalance(fundedLp.address, '100.000000');

  const store = createMemoryStore(null);
  const leader = await bootNode({ mock, bank, store, tag: 'unfunded-guard' });

  try {
    mock.directSubmit(
      signedTx(mock, fundedLp, bank.address, '50.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body
    );
    await leader.settle();
    assert.equal(BigInt(await leader.s._persist.capacityUsed('bets')), 0n);

    // Unfunded attacker crafts a syntactically valid signed BET transfer
    const bogusBet = signedTx(
      mock,
      unfundedAttacker,
      bank.address,
      '0.500000',
      formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 5000, clientSeed: 'grief-attempt' })
    );
    const res = await leader.req('/api/tx/submit', { method: 'POST', body: { tx: bogusBet } });
    assert.equal(res.status, 400, `expected 400 rejection for unfunded sender, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(BigInt(await leader.s._persist.capacityUsed('bets')), 0n, 'zero shared coverage reserved by unfunded sender');
    assert.equal((await leader.s.betCoverage(0n)).usedMicros, 0n, 'zero local/shared coverage reserved');
  } finally {
    await leader.close();
    await mock.close();
  }
});
