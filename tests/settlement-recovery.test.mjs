// @ts-nocheck
/**
 * Settlement recovery (fix/settlement-recovery). Reproduces what happened on poadice.grok.me on
 * 2026-10-25: a real 10 POA `DICE1:LP_ADD` deposit went final on minepoa, the host recycled the
 * process (file state gone), and the vault never booked it because
 *   (1) the minepoa address page lists bank txs WITHOUT memos, so the DICE1 scan skipped it, and
 *   (2) the address `balance` is the last-checkpoint balance, so the bank looked empty.
 * Everything runs against the local mock (realistic mode); nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros, fromMicros } from '../src/crypto-poa.mjs';
import { MinepoaClient } from '../src/minepoa-client.mjs';
import { createRedisRestStore, PersistQueue, resolveStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-recovery-${t}-`));

async function boot({ mock, dataDir, bank, extra = {} }) {
  const app = createDiceServer({
    dataDir,
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey },
    storeEnv: {},
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    ...extra
  });
  const info = await app.listen(0, '127.0.0.1');
  if (app.settlement) app.settlement.client.retryBaseMs = 5;
  const settle = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    await app.settlement.idle();
  };
  return { app, url: info.url, settle, close: () => app.close() };
}

function directTx(mock, wallet, to, amount, memo) {
  return buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents() });
}

/** Minimal Upstash-compatible REST server (POST ["GET",k] / ["SET",k,v]). */
async function startFakeKv() {
  const data = new Map();
  let failNext = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== 'Bearer kv-test-token') return send(401, { error: 'unauthorized' });
    if (failNext > 0) {
      failNext -= 1;
      return send(500, { error: 'kv down' });
    }
    const [cmd, key, val] = JSON.parse(raw);
    if (cmd === 'GET') return send(200, { result: data.has(key) ? data.get(key) : null });
    if (cmd === 'SET') {
      data.set(key, val);
      return send(200, { result: 'OK' });
    }
    return send(400, { error: 'unsupported' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, data, fail: (n) => (failNext = n), close: () => new Promise((r) => server.close(r)) };
}

test('lost state: a final DICE1:LP_ADD found only on the ledger (no memo on the address page, checkpoint balance 0) is booked, then withdrawn on chain', async () => {
  const mock = await startMockMinepoa({ realistic: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  mock.checkpoint(); // checkpoint BEFORE the deposit, like minepoa h22183 vs deposit h22637
  // The deposit lands while no vault process remembers it (exact memo used on 2026-10-25).
  const dep = directTx(mock, player, bank.address, '10.000000', 'DICE1:LP_ADD');
  mock.directSubmit(dep.body);
  mock.finalizeAll();
  assert.equal(mock.checkpointBalanceOf(bank.address), '0.000000', 'explorer balance still shows 0');

  const srv = await boot({ mock, dataDir: tmp('lost1'), bank });
  try {
    // status endpoint finds it on the ledger even before the scan books it
    const pre = await (await fetch(`${srv.url}/api/tx/${dep.id}/status`)).json();
    assert.ok(['CONFIRMED_ON_LEDGER_BOOKING', 'CONFIRMED'].includes(pre.status), JSON.stringify(pre));
    await srv.settle();
    const st = await (await fetch(`${srv.url}/api/tx/${dep.id}/status`)).json();
    assert.equal(st.status, 'CONFIRMED', JSON.stringify(st));
    assert.equal(st.result.action, 'LP_DEPOSIT');
    assert.equal(srv.app.engine.lpPositions.get(player.address).principalDepositedMicros > 0n, true, 'credited to the sender');
    const sum = await (await fetch(`${srv.url}/api/settlement`)).json();
    assert.equal(sum.onChainBankBalancePoa, '10.000000', 'checkpoint 0 + final 10 above checkpoint');
    assert.equal(sum.bankBalance.checkpointBalance, '0.000000');
    assert.equal(sum.lastError, null);
    const audit = await (await fetch(`${srv.url}/api/audit/chain`)).json();
    assert.equal(audit.ok, true, JSON.stringify(audit));

    // Withdraw ALL with a direct trigger tx; payout must go out although the checkpoint still says 0.
    const wd = directTx(mock, player, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' }));
    mock.directSubmit(wd.body);
    mock.finalizeAll();
    await srv.settle(6);
    const outs = mock.transfersFrom(bank.address);
    assert.equal(outs.length, 1, 'one payout broadcast');
    assert.equal(outs[0].body.to, player.address);
    assert.match(outs[0].body.memo, /:ord=[0-9a-f]{12}/);
    mock.finalizeAll();
    await srv.settle();
    const ws = await (await fetch(`${srv.url}/api/tx/${wd.id}/status`)).json();
    assert.equal(ws.payouts[0].status, 'CONFIRMED');
    const paid = toMicros(outs[0].body.amount);
    assert.ok(paid > toMicros('9.9') && paid <= toMicros('10.000001'), `paid ${outs[0].body.amount}`);
  } finally {
    await srv.close();
  }

  // State lost AGAIN after the payout: replay must rebuild deposit+withdraw and adopt the payout, not repeat it.
  const srv2 = await boot({ mock, dataDir: tmp('lost2'), bank });
  try {
    await srv2.settle(6);
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'no second payout after replay');
    const wsum = await (await fetch(`${srv2.url}/api/settlement`)).json();
    assert.equal(wsum.recentOutbound.length, 1);
    assert.equal(wsum.recentOutbound[0].status, 'CONFIRMED');
    assert.equal(srv2.app.engine.lpPositions.get(player.address)?.shares ?? 0n, 0n, 'position closed after replay');
  } finally {
    await srv2.close();
    await mock.close();
  }
});

test('ephemeral store => read-only STORAGE_EPHEMERAL (no bank address handed out), unless explicitly allowed', async () => {
  const mock = await startMockMinepoa({ realistic: true });
  const bank = genKeypair();
  const srv = await boot({ mock, dataDir: tmp('eph'), bank, extra: { dataDirIsPersistent: false } });
  try {
    const h = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(h.settlement.status, 'STORAGE_EPHEMERAL');
    assert.equal(h.settlement.readOnly, true);
    assert.equal(h.bankAddress, null);
    assert.match(h.settlement.error, /KV_REST_API_URL/);
  } finally {
    await srv.app.close();
  }
  const store = resolveStore({ env: { VERCEL: '1', POA_DICE_DATA_DIR: tmp('v') }, dataDir: tmp('v2') });
  assert.equal(store.durable, false, 'a file on Vercel is never durable');
  const kv = resolveStore({ env: { KV_REST_API_URL: 'https://x.upstash.io', KV_REST_API_TOKEN: 't' }, dataDir: tmp('v3'), bankAddress: bank.address });
  assert.equal(kv.kind, 'redis');
  assert.equal(kv.durable, true);
  await mock.close();
});

test('Redis REST (Vercel KV / Upstash) store: state survives a recycled instance; payouts wait for a durable write', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const kv = await startFakeKv();
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '50.000000');
  const env = { KV_REST_API_URL: kv.url, KV_REST_API_TOKEN: 'kv-test-token' };
  const srv = await boot({ mock, dataDir: tmp('kv1'), bank, extra: { storeEnv: env, dataDirIsPersistent: false } });
  let depId;
  try {
    assert.equal(srv.app.settlement.store.kind, 'redis');
    const dep = directTx(mock, player, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 }));
    depId = dep.id;
    mock.directSubmit(dep.body);
    await srv.settle();
    assert.equal((await (await fetch(`${srv.url}/api/tx/${dep.id}/status`)).json()).status, 'CONFIRMED');
    await srv.app.settlement.flush();
    assert.ok([...kv.data.keys()][0].endsWith(`${bank.address}:vault`));
  } finally {
    await srv.close();
  }
  // New instance, new (empty) disk: everything comes back from KV.
  const srv2 = await boot({ mock, dataDir: tmp('kv2'), bank, extra: { storeEnv: env, dataDirIsPersistent: false } });
  try {
    assert.ok(srv2.app.engine.processedTxids.has(depId), 'engine snapshot restored from KV');
    assert.ok(srv2.app.engine.lpPositions.get(player.address).shares > 0n);
    // KV outage: the payout is signed but NOT broadcast until the signed body is durable.
    const wd = directTx(mock, player, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' }));
    mock.directSubmit(wd.body);
    kv.fail(1000);
    await srv2.settle(3);
    assert.equal(mock.transfersFrom(bank.address).length, 0, 'nothing broadcast while the store is down');
    kv.fail(0);
    await srv2.settle(4);
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'broadcast once the store is back');
  } finally {
    await srv2.close();
    await kv.close();
    await mock.close();
  }
});

test('a bet older than the vault state is held for review, never re-rolled', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '50.000000');
  const bet = directTx(mock, player, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 4950, clientSeed: 'old' }));
  bet.body.ts = Math.floor(Date.now() / 1000) - 3600;
  const resigned = buildSignedTransfer({ wallet: player, to: bank.address, amount: '1.000000', memo: bet.body.memo, nonce: bet.body.nonce, parents: bet.body.parents, ts: bet.body.ts });
  mock.directSubmit(resigned.body);
  const srv = await boot({ mock, dataDir: tmp('oldbet'), bank });
  try {
    await srv.settle();
    const st = await (await fetch(`${srv.url}/api/tx/${resigned.id}/status`)).json();
    assert.equal(st.rawStatus, 'NEEDS_REVIEW', JSON.stringify(st));
    assert.equal(mock.transfersFrom(bank.address).length, 0);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('minepoa client: per-attempt timeouts with retries; 503 "origin busy" retried', async () => {
  const mock = await startMockMinepoa({ realistic: true });
  const c = new MinepoaClient({ nodeUrl: mock.url, timeoutMs: 150, retries: 3, retryBaseMs: 5 });
  mock.hangNext(2);
  const row = await c.getAddress(genKeypair().address);
  assert.equal(row.balance, '0.000000');
  assert.equal(c.stats.timeouts, 2);
  let n = 0;
  const flaky = new MinepoaClient({
    nodeUrl: 'http://x',
    retryBaseMs: 1,
    fetchImpl: async () => (++n < 3 ? new Response(JSON.stringify({ error: 'origin busy', retry_after_seconds: 0 }), { status: 503 }) : new Response(JSON.stringify({ id: 'a', body: { memo: 'DICE1:LP_ADD' }, final: 1 }), { status: 200 }))
  });
  const tx = await flaky.getTx('a');
  assert.equal(tx.final, true);
  assert.equal(await flaky.getMemo('a'), 'DICE1:LP_ADD');
  assert.equal(n, 3);
  await mock.close();
});

test('PersistQueue: snapshots at save time, coalesces, surfaces and retries failures', async () => {
  const writes = [];
  let fail = 100;
  const q = new PersistQueue({ kind: 'redis', async save(d) { if (fail-- > 0) throw new Error('down'); writes.push(d); }, load: async () => null });
  const doc = { n: 1 };
  q.save(doc);
  doc.n = 2; // coalescing: only the newest full snapshot is written
  q.save(doc);
  await assert.rejects(q.flush(), /down/);
  assert.equal(writes.length, 0);
  fail = 0;
  await q.flush(); // the failed snapshot is retried
  assert.equal(writes.length, 1);
  assert.deepEqual(writes.at(-1), { n: 2 });
  const s = createRedisRestStore({ url: 'http://127.0.0.1:1', token: 't', key: 'k', timeoutMs: 50 });
  await assert.rejects(s.save({ a: 1 }));
});
