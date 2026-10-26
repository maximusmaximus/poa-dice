// @ts-nocheck
/**
 * fix/serverless-passes. Live on 2026-10-26 (Vercel): the bank writer lease changed hands 16 times in
 * 25 minutes (tokens 122 -> 138) because the instance holding it froze between requests; health flipped
 * between OPEN and NO_ACTIVE_LEADER while the last status was seconds old; a winning payout sat SIGNED for
 * 9 minutes behind minepoa "origin busy" answers and held trading in SOLVENCY_HOLD meanwhile.
 * These tests pin the pass model: any instance runs a bounded pass under the lease and hands it back;
 * bets need a recent GOOD pass (not a live lease); in-flight payouts are counted once; a SENT payout the
 * ledger never saw is rebroadcast with the same signed body; busy/timeouts degrade, they do not hold.
 * Everything runs against the local mock minepoa; nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { MinepoaClient, BusyError } from '../src/minepoa-client.mjs';
import { LedgerProbe } from '../src/ledger-probe.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-passes-${t}-`));
const ADMIN = 'passes-test-admin';
const CRON = 'passes-test-cron';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    passMode: true,
    passEveryMs: 100,
    readPassBudgetMs: 3000,
    ledgerProbeIntervalMs: 0,
    ledgerProbeMinHoldMs: 0,
    ...opts
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
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
const payoutsFor = (mock, bank, betId) => mock.transfersFrom(bank.address).filter((o) => String(o.body.memo).includes(betId.slice(0, 16)));

async function cluster(tag, n = 3, opts = {}, mkStore = null) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '1000.000000');
  const store = mkStore ? mkStore() : createMemoryStore(null);
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push(await boot({ mock, bank, store: mkStore && i ? mkStore() : store, tag: `${tag}-${i}`, opts }));
  mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  await nodes[0].pass(3);
  for (const x of nodes.slice(1)) await x.pass(1);
  return { mock, bank, p, store, nodes, close: async () => { for (const x of nodes) await x.close(); await mock.close(); } };
}

test('frozen instances (lease tokens 122 -> 138 live): passes hand the lease back; trading never flickers to NO_ACTIVE_LEADER', async () => {
  const c = await cluster('frozen', 3, { writerLeaseMs: 400 });
  const [a, b, cc] = c.nodes;
  try {
    for (const x of c.nodes) assert.equal(x.s.writer.status, 'STANDBY', 'nobody keeps the lease between passes');
    assert.equal((await a.req('/api/health')).body.settlement.trading, 'OPEN');
    // b takes the lease and freezes mid-pass (never finishes, never releases).
    assert.equal(await b.s.writer.refresh(), true);
    const frozenToken = b.s.writer.lease.token;
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      for (const x of [a, cc]) {
        const h = (await x.req('/api/health')).body.settlement;
        seen.push(h.trading);
      }
      await sleep(50);
    }
    assert.ok(seen.length > 10);
    assert.deepEqual([...new Set(seen)], ['OPEN'], 'every read on every instance said OPEN');
    // Make sure the frozen lease has expired before checking that someone else carried on (slow CI).
    while (Date.now() < b.s.writer.lease.expiresAt + 50) await sleep(25);
    await a.req('/api/settlement/tick', { auth: CRON });
    const st = c.store.getStatus('leader-status');
    assert.ok(st.token > frozenToken, 'after the frozen lease expired another instance ran passes');
    assert.ok(Date.now() - st.goodAt < 5000, 'a good pass completed recently');
    // The frozen instance wakes up: it is no longer the writer and cannot write the document.
    assert.equal(b.s.writer.canWrite(), false);
    await b.pass(1);
    assert.equal(b.s.writer.status, 'STANDBY');
    assert.equal(c.mock.transfersFrom(c.bank.address).length, 0, 'nothing was signed');
  } finally {
    await c.close();
  }
});

test('stale passes: no good pass within the limit => bets refused on every instance (safe), resumes after a pass', async () => {
  const c = await cluster('stale', 2, { leaderStatusMaxAgeMs: 300, passEveryMs: 60000 });
  const [a, b] = c.nodes;
  try {
    await sleep(400);
    await b.s.ensureReconciled();
    assert.equal(b.s.tradingHold().status, 'NO_ACTIVE_LEADER');
    const x = bet(c.mock, c.p, c.bank, 'stale');
    await assert.rejects(() => b.s.submitInbound(x), (e) => e.status === 503);
    assert.equal(c.mock.tx(x.id), undefined, 'not broadcast');
    await a.req('/api/settlement/tick', { auth: CRON });
    await b.s._observe();
    assert.equal(b.s.tradingHold(), null);
  } finally {
    await c.close();
  }
});

test('3 instances, concurrent passes (cron + request-triggered): every bet settled exactly once, each win paid once', async () => {
  const c = await cluster('concurrent', 3);
  try {
    const bets = [];
    for (let i = 0; i < 6; i++) {
      const node = c.nodes[i % 3];
      const x = bet(c.mock, c.p, c.bank, `concurrent-${i}`);
      const r = await node.req('/api/tx/submit', { method: 'POST', body: { tx: x } });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      bets.push(x);
    }
    for (let round = 0; round < 6; round++) {
      const res = await Promise.all([
        ...c.nodes.map((x) => x.req('/api/settlement/tick', { auth: CRON })),
        ...c.nodes.map((x) => x.req('/api/health')),
        ...c.nodes.map((x) => x.s.tick())
      ]);
      for (const r of res.slice(0, 3)) assert.equal(r.status, 200);
    }
    for (const x of c.nodes) await x.s.idle();
    await c.nodes[0].pass(2);
    const st = c.store.getStatus('leader-status');
    let wins = 0;
    for (const x of bets) {
      assert.ok(await c.store.peek(`bet:${x.id}`), 'rolled once (claim)');
      const views = [];
      for (const n of c.nodes) {
        await n.s._observe();
        views.push(n.s.getTxStatus(x.id));
      }
      assert.ok(views.every((v) => v && v.rawStatus === 'BOOKED'), JSON.stringify(views.map((v) => v?.rawStatus)));
      assert.equal(new Set(views.map((v) => v.result.rollDisplay)).size, 1, 'one roll everywhere');
      const won = views[0].result.won;
      if (won) wins += 1;
      assert.equal(payoutsFor(c.mock, c.bank, x.id).length, won ? 1 : 0, 'paid exactly once');
    }
    assert.equal(c.mock.transfersFrom(c.bank.address).length, wins);
    assert.equal(st.reconcile.status, 'OK');
    const audit = await c.nodes[1].req('/api/audit/chain');
    assert.equal(audit.body.refusedDuplicatePayouts.length, 0);
  } finally {
    await c.close();
  }
});

/** Settle direct-ledger bets until one wins; the payout broadcast meets `fault`. */
async function winWithFault(c, node, fault) {
  for (let i = 0; i < 12; i++) {
    const x = bet(c.mock, c.p, c.bank, `fault-${i}`, 9800);
    c.mock.directSubmit(x.body);
    if (fault) c.mock.inject(fault);
    await node.pass(1);
    const r = c.store.getStatus('leader-status');
    const v = node.s.getTxStatus(x.id);
    if (v?.result?.won) return { x, v, status: r };
    c.mock.clearFaults();
  }
  throw new Error('no win in 12 bets at 98%');
}

test('a payout in flight (signed, not on the ledger yet) never trips SOLVENCY_HOLD', async () => {
  const c = await cluster('inflight', 1, { payoutRetryMaxMs: 60000 });
  const [a] = c.nodes;
  try {
    const { x, v } = await winWithFault(c, a, { kind: 'busy', retryAfter: 30 });
    assert.equal(v.payouts[0].rawStatus, 'SIGNED', 'broadcast refused busy: still signed, same body');
    await a.pass(2); // later passes reconcile while the payout is still signed (live: 9 minutes)
    assert.equal(a.s.getTxStatus(x.id).payouts[0].rawStatus, 'SIGNED');
    const st = c.store.getStatus('leader-status');
    assert.equal(st.reconcile.status, 'OK', JSON.stringify(st.reconcile));
    assert.equal(st.trading, 'OPEN');
    const h = (await a.req('/api/health')).body.settlement;
    assert.equal(h.trading, 'OPEN');
    assert.notEqual(h.ledger.status, 'UNAVAILABLE', 'busy is degraded at most, never a hold');
    assert.equal(payoutsFor(c.mock, c.bank, x.id).length, 0);
  } finally {
    await c.close();
  }
});

test('a SENT payout the ledger never saw is rebroadcast with the SAME signed tx and nonce (never re-signed), paid once', async () => {
  const c = await cluster('rebroadcast', 1, { rebroadcastAfterMs: 50, sentGraceMs: 0, rejectCheckIntervalMs: 0 });
  const [a] = c.nodes;
  try {
    const { x, v } = await winWithFault(c, a, { kind: 'blackhole' });
    const out = v.payouts[0];
    assert.equal(out.rawStatus, 'SENT', 'minepoa said queued');
    assert.equal(c.mock.tx(out.txid), undefined, 'but it never reached the ledger');
    const st0 = c.store.getStatus('leader-status');
    assert.equal(st0.reconcile.status, 'OK', 'sent-but-unseen is in flight, not a solvency hold');
    for (let i = 0; i < 10 && !c.mock.tx(out.txid); i++) {
      await sleep(60);
      await a.pass(1);
    }
    await a.pass(2);
    const sends = c.mock.submits.filter((b) => b.from === c.bank.address);
    assert.ok(sends.length >= 2, 'rebroadcast');
    assert.equal(new Set(sends.map((b) => JSON.stringify(b))).size, 1, 'every send is the identical signed body (same nonce)');
    const after = a.s.getTxStatus(x.id).payouts[0];
    assert.equal(after.txid, out.txid);
    assert.equal(after.superseded.length, 0, 'never re-signed');
    assert.equal(after.rawStatus, 'CONFIRMED');
    assert.equal(payoutsFor(c.mock, c.bank, x.id).length, 1, 'paid exactly once');
  } finally {
    await c.close();
  }
});

test('minepoa busy (retry_after) and timeouts: fail fast, back off, degrade (no hold); payout keeps its body and lands once', async () => {
  // client: a long retry_after opens a busy window; calls inside it fail fast without touching the node
  let calls = 0;
  const cl = new MinepoaClient({
    nodeUrl: 'http://x',
    retryBaseMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'origin busy — retry shortly', retry_after_seconds: 60 }), { status: 503 });
    }
  });
  await assert.rejects(cl.getTx('ab'), (e) => e instanceof BusyError && e.retryAfterMs >= 59000);
  await assert.rejects(cl.getAddress('poa1x'), (e) => e instanceof BusyError);
  assert.equal(calls, 1, 'second call failed fast inside the busy window');
  assert.ok(cl.busy('read'));
  assert.equal(cl.busy('submit'), null, 'reads and submits are tracked separately');
  // probe: busy / timeouts degrade; a real refusal (401) still pauses
  const st = { submit: 400, hang: false };
  const probe = new LedgerProbe({
    nodeUrl: 'https://n',
    fetchImpl: async (url) => {
      if (st.hang) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      const j = (status, o) => ({ status, ok: status < 400, text: async () => JSON.stringify(o) });
      if (url.endsWith('/api/txs')) return j(200, { valid: [{ id: 'a' }, { id: 'b' }] });
      return st.submit === 503 ? j(503, { error: 'origin busy', retry_after_seconds: 30 }) : j(st.submit, { error: 'x' });
    }
  });
  st.submit = 503;
  await probe.probe();
  await probe.probe();
  assert.equal(probe.status, 'DEGRADED');
  assert.equal(probe.hold(), null, 'busy never holds trading');
  st.submit = 400;
  st.hang = true;
  await probe.probe();
  assert.equal(probe.hold(), null, 'timeouts degrade too');
  st.hang = false;
  await probe.probe();
  assert.equal(probe.status, 'OK');
  st.submit = 401;
  await probe.probe();
  await probe.probe();
  assert.ok(probe.hold(), 'a 401 still pauses');

  // server: payout broadcast answered busy => stays SIGNED, retried after retry_after, paid once
  const c = await cluster('busy', 1);
  const [a] = c.nodes;
  try {
    const { x, v } = await winWithFault(c, a, { kind: 'busy', retryAfter: 1 });
    assert.equal(v.payouts[0].rawStatus, 'SIGNED');
    const signedTxid = v.payouts[0].txid;
    assert.equal((await a.req('/api/health')).body.settlement.trading, 'OPEN');
    await sleep(1100);
    await a.pass(3);
    const out = a.s.getTxStatus(x.id).payouts[0];
    assert.equal(out.txid, signedTxid, 'same signed body');
    assert.equal(out.superseded.length, 0);
    assert.equal(out.rawStatus, 'CONFIRMED');
    assert.equal(payoutsFor(c.mock, c.bank, x.id).length, 1);
    // explorer busy (as live): passes fail fast instead of sleeping; a recent good pass keeps bets open
    c.mock.setReadBusy(60);
    const t0 = Date.now();
    const h = (await a.req('/api/health')).body.settlement;
    assert.ok(Date.now() - t0 < 3000, `health answered in ${Date.now() - t0} ms`);
    assert.equal(h.trading, 'OPEN', 'last good pass is recent');
    c.mock.setReadBusy(0);
  } finally {
    await c.close();
  }
});

test('real Postgres: 3 pass-mode instances, concurrent passes, each bet settled once, lease free between passes', { skip: !process.env.POA_DICE_TEST_PG_URL }, async () => {
  const { createPostgresStore } = await import('../src/settlement-store.mjs');
  const key = `test-${Date.now()}-${Math.random().toString(16).slice(2)}:vault`;
  const c = await cluster('pg', 3, {}, () => createPostgresStore({ connectionString: process.env.POA_DICE_TEST_PG_URL, key }));
  try {
    const bets = [];
    for (let i = 0; i < 4; i++) {
      const x = bet(c.mock, c.p, c.bank, `pg-${i}`);
      const r = await c.nodes[i % 3].req('/api/tx/submit', { method: 'POST', body: { tx: x } });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      bets.push(x);
    }
    for (let round = 0; round < 4; round++) await Promise.all(c.nodes.map((x) => x.req('/api/settlement/tick', { auth: CRON })));
    for (const x of c.nodes) await x.s.idle();
    await c.nodes[0].pass(2);
    let wins = 0;
    for (const x of bets) {
      const v = c.nodes[0].s.getTxStatus(x.id);
      assert.equal(v?.rawStatus, 'BOOKED');
      if (v.result.won) wins += 1;
      assert.equal(payoutsFor(c.mock, c.bank, x.id).length, v.result.won ? 1 : 0);
    }
    assert.equal(c.mock.transfersFrom(c.bank.address).length, wins);
    for (const x of c.nodes) assert.equal(x.s.writer.status, 'STANDBY');
    const h = (await c.nodes[2].req('/api/health')).body.settlement;
    assert.equal(h.trading, 'OPEN');
  } finally {
    await c.close();
  }
});
