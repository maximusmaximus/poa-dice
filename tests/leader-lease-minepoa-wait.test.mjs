// @ts-nocheck
/**
 * fix/leader-lease-minepoa-wait. Live on 2026-10-28 (4:28-4:30 AM PT): health said NO_ACTIVE_LEADER for 45+
 * minutes while minepoa answered "busy (retry after 37 s)". Each instance took the bank writer lease
 * (tokens 30655 -> 31341), called minepoa for the takeover check, got "busy" or a timeout, and the lease ran
 * out (or was handed back) before any status was published; the other instance grabbed it and did the same.
 * These tests pin the fix: the writer keeps its lease on a heartbeat while it waits on minepoa, publishes
 * "waiting on minepoa", backs off (never before retry_after), a standby does not steal the lease or pile on,
 * and trading stays held until a real pass completes. Everything runs against the local mock minepoa.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore, createFileStore, leaseRenewBook } from '../src/settlement-store.mjs';
import { BankWriter, WRITER_LEASE } from '../src/bank-writer.mjs';
import { LEADER_STATUS_KEY } from '../src/chain-settlement.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-leasewait-${t}-`));
const ADMIN = 'leasewait-test-admin';
const CRON = 'leasewait-test-cron';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEASE_MS = 300;

async function boot({ mock, bank, store, tag, opts = {} }) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    settlementStore: store,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    adminToken: ADMIN,
    cronSecret: CRON,
    ledgerProbeIntervalMs: 0,
    ledgerProbeMinHoldMs: 0,
    writerLeaseMs: LEASE_MS,
    leaderStatusMaxAgeMs: 400,
    // The fresh-status shortcut (explorer busy, document unchanged since a recent pass) must not apply here:
    // the live status was too old for it.
    trustedBalanceMaxAgeMs: 150,
    takeoverBackoffBaseMs: 100,
    takeoverBackoffMaxMs: 400,
    readPassBudgetMs: 3000,
    ...opts
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  app.settlement.client.busyMaxMs = 1200; // minepoa's retry_after is capped to this (keeps the test short)
  await app.settlement.ready();
  const pass = async (n = 1) => {
    for (let i = 0; i < n; i++) await app.settlement.tick();
    await app.settlement.idle();
  };
  const req = async (p, { method = 'GET', body, auth } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const r = await fetch(`${info.url}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, s: app.settlement, pass, req, close: () => app.close() };
}

const ts = () => Math.floor(Date.now() / 1000);
const tx = (mock, wallet, to, amount, memo) => buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), ts: ts() });
const bet = (mock, p, bank, seed, target = 9500) => tx(mock, p, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: target, clientSeed: seed }));

/** a = the old writer (goes away), b and c = the two instances left. One shared store, 20 POA in the bank. */
async function trio(tag, opts = {}) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '1000.000000');
  const store = createMemoryStore(null);
  const a = await boot({ mock, bank, store, tag: `${tag}-a`, opts });
  mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  mock.checkpoint();
  await a.pass(4);
  const b = await boot({ mock, bank, store, tag: `${tag}-b`, opts });
  const c = await boot({ mock, bank, store, tag: `${tag}-c`, opts });
  // Bank-address reads the SETTLEMENT clients actually sent to minepoa (takeover checks and bank scans). The
  // page's own chain-context reads (server.mjs cachedExplorer) are a separate, cached path and not counted.
  const settleHits = [];
  for (const [name, x] of [['a', a], ['b', b], ['c', c]]) {
    const f = x.s.client.fetch;
    x.s.client.fetch = (url, init) => {
      if (String(url).includes(`/api/explorer/address/${bank.address}`)) settleHits.push({ name, at: Date.now() });
      return f(url, init);
    };
  }
  const bankAddrHits = (since = 0) => settleHits.filter((r) => r.at >= since);
  return { mock, bank, p, store, a, b, c, bankAddrHits, close: async () => { for (const x of [a, b, c]) await x.close().catch(() => {}); await mock.close(); } };
}

/** The old writer goes away, minepoa goes busy, and b takes the lease. Returns b's token. */
async function bTakesOverWhileBusy(t) {
  const st0 = t.store.getStatus(LEADER_STATUS_KEY);
  assert.ok(st0 && st0.goodAt, 'the old writer published a good pass');
  await t.a.close(); // releases the lease
  await sleep(200); // the old status gets older than the fresh-status shortcut allows
  t.mock.setReadBusy(30); // explorer + receipts: 503 "origin busy", retry_after_seconds 30 (capped to 1.2 s here)
  await t.b.pass(1);
  assert.equal(t.b.s.writer.status, 'LEADER', 'b took the lease');
  assert.ok(t.b.s._waitingOnTakeover(), 'b is waiting on minepoa to finish the takeover check');
  return { token: t.b.s.writer.lease.token, goodAt0: st0.goodAt };
}

for (const passMode of [false, true]) {
  const mode = passMode ? 'pass mode (serverless)' : 'long-lived';
  test(`${mode}: busy minepoa during takeover keeps ONE leader with a stable token across several lease periods; health says waiting, not NO_ACTIVE_LEADER; trading held until a pass completes`, async () => {
    const t = await trio(`busy-${passMode ? 'pass' : 'loop'}`, { passMode, passEveryMs: 100 });
    try {
      const { token, goodAt0 } = await bTakesOverWhileBusy(t);
      const t0 = Date.now();
      const seen = { tradingB: new Set(), tradingC: new Set(), stateC: new Set(), tokens: new Set(), cStatus: new Set() };
      // ~6 lease periods of requests, cron ticks and standby ticks on both instances.
      while (Date.now() - t0 < 6 * LEASE_MS) {
        await t.c.pass(1); // the standby tries to run a pass: it must not take the lease
        await t.c.req('/api/settlement/tick', { auth: CRON });
        const hc = (await t.c.req('/api/health')).body.settlement;
        const hb = (await t.b.req('/api/health')).body.settlement;
        seen.tradingB.add(hb.trading);
        seen.tradingC.add(hc.trading);
        seen.stateC.add(hc.leader.state);
        seen.cStatus.add(t.c.s.writer.status);
        seen.tokens.add(t.store.peek(`__lease__:${WRITER_LEASE}`)?.token);
        await sleep(40);
      }
      assert.deepEqual([...seen.tokens], [token], 'one lease token the whole time (no churn)');
      assert.equal(t.b.s.writer.status, 'LEADER');
      assert.deepEqual([...seen.cStatus], ['STANDBY'], 'the standby never took the lease from the live, waiting writer');
      assert.deepEqual([...seen.tradingB], ['HOLD'], 'the waiting writer holds trading');
      assert.deepEqual([...seen.tradingC], ['HOLD'], 'the standby reports a hold, never NO_ACTIVE_LEADER');
      assert.deepEqual([...seen.stateC], ['WAITING_ON_MINEPOA']);
      const hc = (await t.c.req('/api/health')).body.settlement;
      assert.equal(hc.leader.active, true, 'a live leader exists');
      assert.ok(hc.leader.waiting && hc.leader.waiting.attempts >= 1);
      const hb = (await t.b.req('/api/health')).body.settlement;
      assert.equal(hb.leader.thisInstance, 'WRITER_WAITING_ON_MINEPOA');
      assert.match(JSON.stringify(hb.writer), /"running":true/, 'b renews its lease on a heartbeat');
      // The published status is the waiting one: same token, fresh, but no pass time was refreshed.
      const st = t.store.getStatus(LEADER_STATUS_KEY);
      assert.equal(st.token, token);
      assert.ok(st.waiting && st.waiting.on === 'minepoa');
      assert.equal(st.goodAt, goodAt0, 'goodAt is still the last real pass');
      assert.equal(st.hold.status, 'RECONCILING');
      assert.equal(st.coverage.known, false, 'no bank coverage is published while waiting');
      // Bets are refused on both instances and never broadcast.
      const x = bet(t.mock, t.p, t.bank, `wait-${passMode}`);
      const rc = await t.c.req('/api/tx/submit', { method: 'POST', body: { tx: x } });
      assert.equal(rc.status, 503, JSON.stringify(rc.body));
      assert.match(JSON.stringify(rc.body), /waiting on minepoa/);
      const rb = await t.b.req('/api/tx/submit', { method: 'POST', body: { tx: x } });
      assert.equal(rb.status, 503, JSON.stringify(rb.body));
      assert.match(JSON.stringify(rb.body), /waiting on minepoa/);
      assert.equal(t.mock.tx(x.id), undefined, 'not broadcast');
      assert.equal(t.mock.transfersFrom(t.bank.address).length, 0, 'the bank signed nothing');
      // minepoa recovers: the same writer finishes its takeover and its first pass, then trading opens.
      t.mock.setReadBusy(0);
      const t1 = Date.now();
      const goodNow = () => Number(t.store.getStatus(LEADER_STATUS_KEY)?.goodAt || 0) > goodAt0;
      while (Date.now() - t1 < 8000 && (t.b.s._waitingOnTakeover() || !goodNow())) {
        await t.b.pass(1).catch(() => {});
        await sleep(50);
      }
      assert.equal(t.b.s._waitingOnTakeover(), false, 'takeover finished');
      assert.ok(t.store.getStatus(LEADER_STATUS_KEY).goodAt > goodAt0, 'a good pass completed');
      assert.equal(t.store.getStatus(LEADER_STATUS_KEY).waiting, null);
      if (!passMode) assert.equal(t.b.s.writer.lease.token, token, 'the same lease carried through to the first pass');
      await t.c.s._observe();
      const after = (await t.c.req('/api/health')).body.settlement;
      assert.equal(after.trading, 'OPEN', JSON.stringify(after.leader));
      assert.equal(after.leader.state, 'ACTIVE');
    } finally {
      await t.close();
    }
  });
}

test('slow minepoa: an address read that takes 3+ lease periods does not lose the lease mid-takeover (heartbeat)', async () => {
  const t = await trio('slow');
  try {
    await t.a.close();
    await sleep(200);
    t.mock.setAddressDelay(4 * LEASE_MS);
    const run = t.b.pass(1);
    await sleep(30);
    assert.equal(t.b.s.writer.status, 'LEADER');
    const token = t.b.s.writer.lease.token;
    let done = false;
    run.then(() => (done = true));
    const cStatuses = new Set();
    while (!done) {
      assert.equal(await t.c.s.writer.refresh(), false, 'the standby cannot take a lease that is being renewed');
      cStatuses.add(t.c.s.writer.status);
      await sleep(40);
    }
    assert.deepEqual([...cStatuses], ['STANDBY']);
    assert.equal(t.b.s.writer.lease.token, token, 'same token after the slow call');
    assert.equal(t.b.s._waitingOnTakeover(), false, 'the takeover finished on the slow answer');
    assert.ok(t.b.s.writer.heartbeat.beats >= 2, `renewed while waiting (${t.b.s.writer.heartbeat.beats} beats)`);
    assert.equal(t.b.s.tradingHold(), null, 'the first pass completed: trading open');
  } finally {
    t.mock.setAddressDelay(0);
    await t.close();
  }
});

test('backoff honors retry_after: no takeover call to minepoa before it, and the standby adds no calls', async () => {
  const t = await trio('backoff');
  try {
    await bTakesOverWhileBusy(t);
    const w = t.b.s._takeoverWait;
    assert.ok(w.retryAfterMs >= 1000, `minepoa's retry_after was seen (${w.retryAfterMs} ms)`);
    assert.ok(w.nextAt - w.triedAt >= w.retryAfterMs, 'next try is no sooner than retry_after');
    const since = Date.now();
    const deadline = w.nextAt;
    while (Date.now() < deadline - 50) {
      await t.b.pass(1);
      await t.c.pass(1);
      await t.c.req('/api/health');
      await sleep(30);
    }
    assert.equal(t.bankAddrHits(since).filter((r) => r.at < deadline).length, 0, 'nobody asked minepoa for the bank address before retry_after');
    // Pure backoff math: never before retry_after, exponential with jitter, capped.
    const s = t.b.s;
    for (const r of [0, 0.5, 0.999]) {
      s._random = () => r;
      assert.ok(s._takeoverDelay(1, 37000) >= 37000, 'retry after 37 s means at least 37 s');
      assert.ok(s._takeoverDelay(1, 37000) <= 37000 * 1.2 + 1);
      assert.ok(s._takeoverDelay(1, 0) >= 50 && s._takeoverDelay(1, 0) <= 100);
      assert.ok(s._takeoverDelay(10, 0) <= 400, 'capped at takeoverBackoffMaxMs');
      assert.ok(s._takeoverDelay(3, 0) >= 200, 'grows: base * 2^(n-1), at least half of it');
    }
  } finally {
    await t.close();
  }
});

test('a new writer adopts the published retry time of the waiting writer it replaces (no pile-on after a handover)', async () => {
  const t = await trio('adopt');
  try {
    await bTakesOverWhileBusy(t);
    const retryAt = t.b.s._takeoverWait.nextAt;
    // b freezes/vanishes without releasing (its heartbeat stops): its lease lapses; c takes over.
    t.b.s.writer.stopHeartbeat();
    t.b.s.writer.renewLease = null;
    t.b.s.writer.startHeartbeat = () => false;
    t.b.s.writer.onBeat = null;
    while (Date.now() < t.b.s.writer.lease.expiresAt + 20) await sleep(20);
    const since = Date.now();
    await t.c.pass(1);
    assert.equal(t.c.s.writer.status, 'LEADER', 'c took the expired lease');
    assert.ok(t.c.s._waitingOnTakeover());
    assert.ok(t.c.s._takeoverWait.nextAt >= retryAt, 'c waits at least until the retry time b published');
    assert.equal(t.bankAddrHits(since).filter((r) => r.at < retryAt).length, 0, 'c did not call minepoa before that time');
    assert.equal(t.store.getStatus(LEADER_STATUS_KEY).holder, t.c.s.writer.holderId, 'c now publishes the waiting status');
  } finally {
    await t.close();
  }
});

test('a frozen waiting writer (no heartbeat) is not reported as live: NO_ACTIVE_LEADER once its status and lease run out', async () => {
  const t = await trio('frozen-wait');
  try {
    await bTakesOverWhileBusy(t);
    await t.c.s._observe();
    assert.equal(t.c.s.tradingHold().status, 'RECONCILING');
    // b freezes: no more heartbeats, no more status.
    t.b.s.writer.stopHeartbeat();
    t.b.s.writer.startHeartbeat = () => false;
    t.b.s.writer.onBeat = null;
    await sleep(2 * LEASE_MS + 150);
    await t.c.s._standbyTick();
    assert.equal(t.c.s.tradingHold().status, 'NO_ACTIVE_LEADER', 'nobody alive holds the lease: no false "waiting" claim');
    assert.equal(t.c.s.leaderView().state, 'NONE');
  } finally {
    await t.close();
  }
});

test('a waiting status never enables the "fresh published status" takeover shortcut (only a real pass does)', async () => {
  const t = await trio('verified');
  try {
    await bTakesOverWhileBusy(t);
    const st = t.store.getStatus(LEADER_STATUS_KEY);
    assert.ok(st.waiting);
    assert.ok(Date.now() - st.at < 1000, 'the waiting status itself is fresh');
    t.c.s._loadedSavedAt = st.docSavedAt;
    assert.equal(await t.c.s._handoverFromFreshStatus({ version: 1 }), false, 'but it is not a verified pass');
  } finally {
    await t.close();
  }
});

test('lease heartbeat renews only a lease still held with the same token; it never re-takes a lost one', async () => {
  // store level (memory + file)
  for (const store of [createMemoryStore(null), createFileStore(tmp('lease-file'))]) {
    const l = await store.lease(WRITER_LEASE, 'A', 200);
    const r1 = await store.renewLease(WRITER_LEASE, 'A', l.token, 200);
    assert.equal(r1.held, true);
    assert.equal(r1.token, l.token);
    assert.equal((await store.renewLease(WRITER_LEASE, 'A', l.token + 1, 200)).held, false, 'wrong token');
    assert.equal((await store.renewLease(WRITER_LEASE, 'B', l.token, 200)).held, false, 'wrong holder');
    await store.releaseLease(WRITER_LEASE, 'A');
    assert.equal((await store.renewLease(WRITER_LEASE, 'A', l.token, 200)).held, false, 'released: not re-taken by a heartbeat');
    const b = await store.lease(WRITER_LEASE, 'B', 200);
    assert.equal(b.held, true, 'someone else can take it');
  }
  assert.equal(leaseRenewBook({ holder: 'A', token: 3, expiresAt: Date.now() - 1 }, 'A', 3, 100, Date.now()).held, false, 'expired: not renewed');
  // writer level: the heartbeat keeps it across lease periods, and goes read-only at once when it is lost.
  const store = createMemoryStore(null);
  await store.claim('store-binding', { bankAddress: 'bank', storeId: 's', boundAt: 'x', via: 'test', priorLedgerIds: [] });
  const w = new BankWriter({ store, bankAddress: 'bank', enabled: true, leaseMs: 150 });
  assert.equal(await w.refresh(), true);
  const token = w.lease.token;
  w.startHeartbeat();
  await sleep(600);
  assert.equal(w.status, 'LEADER');
  assert.equal(w.lease.token, token);
  assert.equal((await store.lease(WRITER_LEASE, 'other', 150)).held, false, 'still held after 4 lease periods');
  // stolen (e.g. the store was edited, or this instance was frozen past expiry): the next beat notices
  const k = `__lease__:${WRITER_LEASE}`;
  await store.releaseLease(WRITER_LEASE, w.holderId);
  const other = await store.lease(WRITER_LEASE, 'other', 5000);
  assert.ok(other.held && other.token > token);
  await sleep(150);
  assert.equal(w.status, 'STANDBY', 'lost: read-only');
  assert.equal(w.canWrite(), false);
  assert.equal(w.heartbeat.running, false);
  assert.equal((await store.lease(WRITER_LEASE, 'other', 5000)).token, other.token, 'the heartbeat did not take it back');
  assert.ok(k);
  // a stalled settlement loop (no touch) stops renewing, so the lease lapses
  const store2 = createMemoryStore(null);
  await store2.claim('store-binding', { bankAddress: 'bank', storeId: 's', boundAt: 'x', via: 'test', priorLedgerIds: [] });
  const w2 = new BankWriter({ store: store2, bankAddress: 'bank', enabled: true, leaseMs: 150, heartbeatStallMs: 200 });
  assert.equal(await w2.refresh(), true);
  w2.touch();
  w2.startHeartbeat();
  await sleep(600);
  assert.equal(w2.heartbeat.stalled, true);
  assert.equal((await store2.lease(WRITER_LEASE, 'other', 150)).held, true, 'a wedged writer does not hold the lease forever');
  w2.stopHeartbeat();
});
