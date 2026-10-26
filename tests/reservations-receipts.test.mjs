// @ts-nocheck
/**
 * fix/reservations-receipts. Live on 2026-10-26 (Vercel, pass mode):
 *  - the stored lockedCollateral reached -4.552880 POA: every reload restored the stored lock but kept this
 *    process's in-memory reservations, and every save subtracted them again; the next bet (w3, 1 POA) failed
 *    the accounting invariant AFTER settleBet had booked its wager, and was refunded, so the wager was
 *    counted twice and trading went to SOLVENCY_HOLD by exactly the refund (0.999999 POA);
 *  - "probe: /api/txs HTTP 200" (an ~800 KB body that did not finish in time) and timeouts paused trading;
 *  - the explorer answered "origin busy" for an hour while /api/receipt said `included`: payout 269433a2
 *    stayed SENT_UNCONFIRMED_STALE, and the queued refund could not get a bank nonce.
 * Everything here runs against the local mock minepoa; nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { BusyError } from '../src/minepoa-client.mjs';
import { LedgerProbe, isLedgerBusy } from '../src/ledger-probe.mjs';
import { BankrollEngine } from '../src/bankroll-engine.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-rr-${t}-`));
const ADMIN = 'rr-test-admin';
const CRON = 'rr-test-cron';
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
    sentGraceMs: 0,
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
  let id = 0;
  const mcp = async (name, args = {}) => {
    const r = await fetch(`${info.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json();
    return { isError: j.result.isError, data: JSON.parse(j.result.content[0].text) };
  };
  return { app, s: app.settlement, pass, req, mcp, close: () => app.close() };
}

const ts = () => Math.floor(Date.now() / 1000);
const tx = (mock, wallet, to, amount, memo) => buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), ts: ts() });
const bet = (mock, p, bank, seed, target = 5000) => tx(mock, p, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: target, clientSeed: seed }));

async function cluster(tag, n = 2, opts = {}, mockOpts = {}) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true, ...mockOpts });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '1000.000000');
  const store = createMemoryStore(null);
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push(await boot({ mock, bank, store, tag: `${tag}-${i}`, opts }));
  mock.directSubmit(tx(mock, p, bank.address, '500.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  mock.finalizeAll();
  await nodes[0].pass(3);
  for (const x of nodes.slice(1)) await x.pass(1);
  const extra = [];
  return {
    mock,
    bank,
    p,
    store,
    nodes,
    boot: async (t, o = {}) => {
      const x = await boot({ mock, bank, store, tag: `${tag}-${t}`, opts: { ...opts, ...o } });
      extra.push(x);
      return x;
    },
    close: async () => {
      for (const x of [...nodes, ...extra]) await x.close();
      await mock.close();
    }
  };
}

const storedLocked = (store) => store.load().engine.lockedCollateralMicros;
const reservedHere = (s) => [...s.engine.batchReservations.values()].reduce((a, b) => a + b, 0n);

// ─── 1. reserved funds ──────────────────────────────────────────────────────

test('multi-instance reload-and-save loop: locked collateral stays exactly the open reservations (never drifts, never negative)', async () => {
  const c = await cluster('lockloop', 3, {}, { autoFinal: false, realistic: false });
  const [a, b, d] = c.nodes;
  try {
    // A bet sent through MCP to a standby: that process reserves its exposure in memory (pending_<txid>).
    const x = bet(c.mock, c.p, c.bank, 'lockloop');
    // Exactly what the MCP bet path does (mcp-server _submitPlayerTx): reserve in memory, then submit.
    const reserve = { key: `pending_${x.id}`, micros: '981500' };
    b.s.engine.reserveExposure(reserve.key, BigInt(reserve.micros));
    await b.s.submitInbound(x, { reserve });
    const held = reservedHere(b.s);
    assert.ok(held > 0n, 'the standby holds the reservation in memory');
    // Not final yet: every instance runs passes and reloads/saves the shared vault many times.
    for (let round = 0; round < 12; round++) {
      await Promise.all([...c.nodes.map((n) => n.req('/api/settlement/tick', { auth: CRON })), ...c.nodes.map((n) => n.s.tick()), b.s._observe()]);
      for (const n of c.nodes) {
        await n.s.idle();
        assert.ok(n.s.engine.lockedCollateralMicros >= 0n, `round ${round}: never negative`);
        assert.equal(n.s.engine.lockedCollateralMicros, n.s.engine.derivedLockedMicros(), 'derived, not accumulated');
      }
      assert.equal(storedLocked(c.store), '0', `round ${round}: the stored lock never absorbs reservations`);
      assert.equal(b.s.engine.lockedCollateralMicros, held, `round ${round}: the open bet is locked exactly once on the instance that took it`);
    }
    c.mock.finalizeAll();
    for (let i = 0; i < 4; i++) await Promise.all(c.nodes.map((n) => n.s.tick()));
    for (const n of c.nodes) await n.s.idle();
    await a.pass(1);
    const v = a.s.getTxStatus(x.id);
    assert.equal(v.rawStatus, 'BOOKED');
    assert.equal(v.result.action, 'BET_SETTLED', 'rolled, not refunded');
    for (const n of [a, b, d]) {
      await n.pass(1);
      assert.equal(n.s.engine.lockedCollateralMicros, 0n, 'nothing left locked once the bet settled');
    }
    assert.equal(storedLocked(c.store), '0');
  } finally {
    await c.close();
  }
});

test('engine: locked collateral is derived; a stored -4.552880 POA is corrected on load (and recorded)', () => {
  const e = new BankrollEngine({ bankAddress: genKeypair().address });
  const raw = e.serializeState();
  raw.lockedCollateralMicros = '-4552880';
  const f = new BankrollEngine({ bankAddress: e.bankAddress });
  f.bankNavMicros = 10_000_000n;
  f.reserveExposure('pending_x', 1000000n);
  f.restoreState(raw);
  assert.equal(f.lockedCollateralMicros, 1000000n, 'stored value is not trusted: derived from what is open here');
  assert.deepEqual([f.lockHeal.storedMicros, f.lockHeal.correctedMicros], ['-4552880', '0']);
  assert.equal(f.serializeState().lockedCollateralMicros, '0', 'reservations are never written into the stored lock');
  f.releaseExposure('pending_x', null);
  f.releaseExposure('pending_x', null);
  assert.equal(f.lockedCollateralMicros, 0n, 'double release cannot go negative');
});

// ─── live replay: -4.55 lock + half-applied refunded bet + busy explorer ──────

/** Bets at 95% until one wins; returns its payout record once it is SENT or CONFIRMED. */
async function aWin(c, node, tag) {
  for (let i = 0; i < 10; i++) {
    const x = bet(c.mock, c.p, c.bank, `${tag}-${i}`, 9500);
    c.mock.directSubmit(x.body);
    c.mock.finalizeAll();
    await node.pass(2);
    const v = node.s.getTxStatus(x.id);
    if (v?.result?.won) return { x, v };
  }
  throw new Error('no win in 10 bets at 95%');
}

test('live replay: first pass after deploy heals the lock, undoes the double-booked refund, confirms from receipts, and the refund goes out once', async () => {
  const c = await cluster('replay', 2);
  const [a] = c.nodes;
  try {
    // An earlier win, confirmed (the bank has nonce history, like payouts 1..9 live).
    const w1 = await aWin(c, a, 'w1');
    c.mock.finalizeAll();
    await a.pass(2);
    assert.equal(a.s.getTxStatus(w1.x.id).payouts[0].rawStatus, 'CONFIRMED');
    // A win whose payout is on the ledger while the explorer goes "origin busy" (receipts still answer): 269433a2.
    const w2 = await aWin(c, a, 'w2');
    const p2 = a.s.getTxStatus(w2.x.id).payouts[0];
    // The w3 bet: final, then booked while the invariant fails (live: lock -4.55) and no nonce can be read.
    c.mock.setReadBusy(0);
    const x3 = bet(c.mock, c.p, c.bank, 'w3', 5000);
    c.mock.directSubmit(x3.body);
    c.mock.finalizeAll();
    const eng = a.s.engine;
    const origSettle = eng.settleBet.bind(eng);
    const origAssert = eng.assertAccountingInvariant.bind(eng);
    let armed = false;
    eng.settleBet = (...args) => {
      armed = true;
      try {
        return origSettle(...args);
      } finally {
        armed = false;
      }
    };
    eng.assertAccountingInvariant = () => {
      if (armed) throw new Error('Accounting invariant failed: lockedCollateralMicros (-4552880) < 0');
      return origAssert();
    };
    const origChoose = a.s._chooseBankNonce.bind(a.s);
    a.s._chooseBankNonce = async () => {
      throw new BusyError('minepoa /api/explorer/address -> busy (retry after 60 s)', { retryAfterMs: 60000 });
    };
    const before = { nav: eng.bankNavMicros, dev: eng.devReserveMicros, inc: eng.incentivePoolMicros };
    await a.pass(1);
    eng.settleBet = origSettle;
    eng.assertAccountingInvariant = origAssert;
    a.s._chooseBankNonce = origChoose;
    const v3 = a.s.getTxStatus(x3.id);
    assert.equal(v3.result.action, 'REFUND_QUEUED', 'refused by the invariant => SAFE_REFUND (unchanged behavior)');
    assert.match(v3.result.reason, /^Accounting invariant failed/);
    assert.deepEqual({ nav: eng.bankNavMicros, dev: eng.devReserveMicros, inc: eng.incentivePoolMicros }, before, 'settlement is all-or-nothing now: the refused bet left the books untouched');
    const refund = v3.payouts[0];
    assert.equal(refund.kind, 'SAFE_REFUND');
    assert.equal(refund.rawStatus, 'QUEUED');
    assert.equal(refund.amountPoa, '0.999999');
    assert.equal(a.s.reconcile.status, 'OK', 'a queued refund is covered by its own deposit: no SOLVENCY_HOLD');

    // Reproduce the live document exactly: the old code had ALSO booked the lost wager, and the lock is -4.55.
    const doc = c.store.load();
    const w = toMicros('1.000000');
    const { devFeeMicros, incentiveFeeMicros } = eng.feesForWager(w, false);
    const add = (k, v) => (doc.engine[k] = (BigInt(doc.engine[k]) + v).toString());
    add('bankNavMicros', w - devFeeMicros - incentiveFeeMicros);
    add('netHouseProfitMicros', w - devFeeMicros - incentiveFeeMicros);
    add('devReserveMicros', devFeeMicros);
    add('totalDevEarnedMicros', devFeeMicros);
    add('incentivePoolMicros', incentiveFeeMicros);
    add('totalVolumeMicros', w);
    doc.engine.totalBetsCount += 1;
    doc.engine.totalPlayerLossesCount += 1;
    doc.engine.lockedCollateralMicros = '-4552880';
    if (doc.outbound[p2.orderId]) doc.outbound[p2.orderId].status = 'SENT';
    c.store.save(doc);
    for (const n of c.nodes) await n.close();
    c.nodes.length = 0;

    // Deploy: the explorer is busy (address + tx pages), receipts answer. A fresh instance runs the first pass.
    c.mock.setReadBusy(60, { receipts: false });
    const fresh = await c.boot('deploy');
    assert.equal(fresh.s.engine.lockedCollateralMicros, 0n, 'healed on load');
    assert.equal(fresh.s.engine.lockHeal.storedMicros, '-4552880');
    await fresh.pass(1);
    assert.equal(storedLocked(c.store), '0', 'the stored lock is repaired by the first pass (no manual DB edit)');
    const rec3 = fresh.s.state.inbound[x3.id];
    assert.ok(rec3.halfApplyRepaired, 'the double-booked wager was undone');
    assert.deepEqual({ nav: fresh.s.engine.bankNavMicros, dev: fresh.s.engine.devReserveMicros, inc: fresh.s.engine.incentivePoolMicros }, before);
    assert.equal(fresh.s.reconcile.status, 'OK', JSON.stringify(fresh.s.reconcile));
    assert.equal(fresh.s.getTxStatus(w2.x.id).payouts[0].rawStatus, 'CONFIRMED', '269433a2-like payout confirmed from its receipt');
    assert.equal(fresh.s.state.outbound[p2.orderId].confirmedVia, 'receipt');
    await fresh.pass(2);
    const out = fresh.s.getTxStatus(x3.id).payouts[0];
    assert.ok(['SENT', 'CONFIRMED'].includes(out.rawStatus), `refund went out with a nonce from receipts: ${JSON.stringify(out)}`);
    const refunds = c.mock.transfersFrom(c.bank.address).filter((t) => String(t.body.memo).startsWith(`DICE1:REFUND:${x3.id.slice(0, 16)}`));
    assert.equal(refunds.length, 1, 'refund sent exactly once');
    const nonces = c.mock.transfersFrom(c.bank.address).map((t) => t.body.nonce);
    assert.equal(new Set(nonces).size, nonces.length, 'no bank nonce reused');
    // Health stays open, the ledger is only degraded, the audit answers from the last trusted read.
    const h = (await fresh.req('/api/health')).body.settlement;
    assert.equal(h.trading, 'OPEN', JSON.stringify(h.tradingHold || h.reconcile));
    assert.notEqual(h.ledger.status, 'UNAVAILABLE');
    const au = await fresh.req('/api/audit/chain');
    assert.equal(au.status, 200, JSON.stringify(au.body));
    assert.equal(au.body.ok, true, JSON.stringify(au.body));
    assert.equal(au.body.balanceFrom, 'last-trusted-read');
    // A second pass never repairs twice.
    const nav = fresh.s.engine.bankNavMicros;
    await fresh.pass(2);
    assert.equal(fresh.s.engine.bankNavMicros, nav);
    // Explorer back: everything confirms, audit from the ledger, still exactly one refund.
    c.mock.setReadBusy(0);
    fresh.s.client._busyUntil.read = 0;
    c.mock.finalizeAll();
    await fresh.pass(2);
    assert.equal(fresh.s.getTxStatus(x3.id).payouts[0].rawStatus, 'CONFIRMED');
    const au2 = await fresh.req('/api/audit/chain');
    assert.equal(au2.body.ok, true, JSON.stringify(au2.body));
    assert.equal(au2.body.balanceFrom, 'ledger');
    assert.equal(au2.body.refusedDuplicatePayouts.length, 0);
    assert.equal(c.mock.transfersFrom(c.bank.address).filter((t) => String(t.body.memo).startsWith(`DICE1:REFUND:${x3.id.slice(0, 16)}`)).length, 1);
  } finally {
    await c.close();
  }
});

test('a half-applied refund is NOT undone when the gap is not explained by it (left to SOLVENCY_HOLD)', async () => {
  const c = await cluster('norepair', 1);
  const [a] = c.nodes;
  try {
    const x = bet(c.mock, c.p, c.bank, 'nr', 5000);
    c.mock.directSubmit(x.body);
    c.mock.finalizeAll();
    await a.pass(1);
    const rec = a.s.state.inbound[x.id];
    // Pretend it was refused by the invariant, but the books are short by MORE than its wager.
    rec.result = { action: 'REFUND_QUEUED', reason: 'Accounting invariant failed: test' };
    a.s.engine.processedTxids.set(x.id, { action: 'REFUND_QUEUED' });
    assert.equal(a.s._repairHalfAppliedRefunds(toMicros('5.000000')), 0);
    assert.equal(rec.halfApplyRepaired, undefined);
  } finally {
    await c.close();
  }
});

// ─── 2. slow ledger ─────────────────────────────────────────────────────────

function fakeNode() {
  const st = { txs: 'ok', submit: 400 };
  const fetchImpl = async (url) => {
    const res = (status, text, bodyFails = false) => ({ status, ok: status < 400, text: async () => {
      if (bodyFails) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return text;
    } });
    if (url.endsWith('/api/txs')) {
      if (st.txs === 'ok') return res(200, JSON.stringify({ valid: [{ id: 'a' }, { id: 'b' }] }));
      if (st.txs === 'badbody') return res(200, '<html>maintenance</html>');
      if (st.txs === 'busybody') return res(200, JSON.stringify({ error: 'origin busy', retry_after_seconds: 60 }));
      if (st.txs === 'truncated') return res(200, '', true);
      if (st.txs === 'hang') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return res(Number(st.txs), JSON.stringify({ error: 'x' }));
    }
    return res(st.submit, JSON.stringify({ error: 'bad tx type' }));
  };
  return { st, fetchImpl };
}

test('probe: HTTP 200 with a bad / busy / unfinished body, 429, 503, 504 and timeouts are DEGRADED, not a hold', async () => {
  const { st, fetchImpl } = fakeNode();
  let t = 1_000_000;
  const p = new LedgerProbe({ fetchImpl, now: () => t, outageHoldMs: 10 * 60 * 1000 });
  assert.equal(await p.probe(), null);
  for (const mode of ['badbody', 'busybody', 'truncated', 'hang', '429', '503', '504', '502']) {
    st.txs = mode;
    for (let i = 0; i < 5; i++) {
      t += 20000;
      await p.probe();
    }
    assert.equal(p.status, 'DEGRADED', mode);
    assert.equal(p.hold(), null, `${mode}: no hold`);
    st.txs = 'ok';
    t += 20000;
    await p.probe();
    assert.equal(p.status, 'OK', `${mode}: recovers`);
  }
  st.txs = 'badbody';
  t += 20000;
  await p.probe();
  assert.match(p.lastError, /\/api\/txs HTTP 200 \(unexpected body\)/, 'the 10:49 AM PT case is named');
  assert.equal(isLedgerBusy(new Error('minepoa /api/explorer/address/x -> HTTP 503')), true);
  assert.equal(isLedgerBusy({ status: 401 }), false);
});

test('probe: only a sustained outage (no healthy answer for outageHoldMs) or a wrong answer pauses; shared lastOkAt counts', async () => {
  const { st, fetchImpl } = fakeNode();
  let t = 1_000_000;
  const p = new LedgerProbe({ fetchImpl, now: () => t, outageHoldMs: 10 * 60 * 1000, minHoldMs: 0 });
  await p.probe();
  st.txs = '503';
  for (let i = 0; i < 29; i++) {
    t += 20000;
    await p.probe();
  }
  assert.equal(p.status, 'DEGRADED', '9 min 40 s without a healthy answer: still degraded');
  t += 30000;
  await p.probe();
  assert.equal(p.status, 'UNAVAILABLE', 'past 10 minutes: paused');
  assert.match(p.lastError, /no healthy answer from minepoa for \d+ s/);
  st.txs = 'ok';
  await p.probe();
  t += 1000;
  await p.probe();
  assert.equal(p.status, 'OK', 'resumes after healthy probes');
  // A fresh (serverless) instance: its own clock starts now, but the writer status says minepoa was last
  // healthy 11 minutes ago, so the outage is already sustained.
  const q = new LedgerProbe({ fetchImpl, now: () => t, outageHoldMs: 10 * 60 * 1000 });
  q.noteRemoteOk(t - 11 * 60 * 1000);
  st.txs = '503';
  await q.probe();
  assert.equal(q.status, 'UNAVAILABLE');
  // Wrong answers still pause: 401 on two probes, or at once on a real payout.
  const r = new LedgerProbe({ fetchImpl, now: () => t });
  st.txs = '401';
  await r.probe();
  t += 20000;
  await r.probe();
  assert.ok(r.hold(), '401 pauses');
  const s2 = new LedgerProbe({ fetchImpl, now: () => t });
  s2.reportFailure('payout broadcast', Object.assign(new Error('Unauthorized'), { status: 403 }));
  assert.ok(s2.hold());
  const s3 = new LedgerProbe({ fetchImpl, now: () => t });
  s3.reportFailure('payout broadcast', Object.assign(new Error('minepoa /api/submit -> HTTP 503'), { status: 503 }));
  assert.equal(s3.status, 'DEGRADED');
});

test('audit: explorer busy => last trusted balance (+ in-flight) within the freshness bound, 503 beyond it', async () => {
  const c = await cluster('auditfb', 1, { trustedBalanceMaxAgeMs: 1500 });
  const [a] = c.nodes;
  try {
    c.mock.setReadBusy(60, { receipts: false });
    a.s.client._busyUntil.read = 0;
    const r = await a.req('/api/audit/chain');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.balanceFrom, 'last-trusted-read');
    assert.ok(r.body.trustedBalanceAgeMs <= 1500);
    await sleep(1600);
    const r2 = await a.req('/api/audit/chain');
    assert.equal(r2.status, 503, 'too old to stand in: no guess');
  } finally {
    await c.close();
  }
});

// ─── 3. receipts ────────────────────────────────────────────────────────────

test('receipt-only confirmation: included + matching txid/body => CONFIRMED; a mismatching receipt never confirms', async () => {
  const c = await cluster('receipt', 1);
  const [a] = c.nodes;
  try {
    const w = await aWin(c, a, 'r');
    const orderId = w.v.payouts[0].orderId;
    const edit = (fn) => {
      const doc = c.store.load();
      fn(doc.outbound[orderId]);
      c.store.save(doc);
    };
    const stored = () => c.store.load().outbound[orderId];
    edit((o) => {
      o.status = 'SENT';
      delete o.confirmedVia;
    });
    const o = stored();
    c.mock.setReadBusy(60, { receipts: false });
    const other = o.to === c.p.address ? c.bank.address : c.p.address;
    for (const [why, receipt] of [
      ['wrong txid', { txid: 'f'.repeat(64), status: 'included' }],
      ['wrong recipient', { txid: o.txid, status: 'included', to: other }],
      ['wrong amount', { txid: o.txid, status: 'included', amount: '999.000000' }],
      ['wrong nonce', { txid: o.txid, status: 'included', nonce: o.nonce + 7 }],
      ['pending', { txid: o.txid, status: 'pending' }]
    ]) {
      c.mock.setReceipt(o.txid, receipt);
      await a.pass(1);
      assert.equal(stored().status, 'SENT', why);
    }
    // the live shape {txid, ts, status: included, height}; the signed body comes from the store's payout claim
    edit((x) => {
      x.body = null;
    });
    c.mock.setReceipt(o.txid, { txid: o.txid, ts: 1793030540, status: 'included', height: 2358 });
    await a.pass(1);
    const done = stored();
    assert.equal(done.status, 'CONFIRMED');
    assert.equal(done.confirmedVia, 'receipt');
    assert.equal(done.receipt.height, 2358);
    assert.equal(a.s.stuckPayouts().length, 0, 'no longer SENT_UNCONFIRMED_STALE');
    assert.equal(c.mock.transfersFrom(c.bank.address).length, 1, 'confirming never sends anything');
  } finally {
    await c.close();
  }
});
