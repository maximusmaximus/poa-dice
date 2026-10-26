// @ts-nocheck
/**
 * fix/pg-startup-race. After PR #12 deployed, production stayed read-only with
 *   "Could not load vault state from postgres: duplicate key value violates unique constraint pg_type_typname_nsp_index"
 * Two instances ran CREATE TABLE IF NOT EXISTS for the new lease table at the same moment (a known Postgres
 * race), the first vault load failed, and that failure was permanent until a restart.
 * Here: schema setup is serialized with an advisory lock and tolerates the race; a failed load is retried
 * with backoff while the instance stays read-only, and binding + lease follow a delayed successful load.
 * Real-Postgres cases run when POA_DICE_TEST_PG_URL is set (a server where the user may CREATE DATABASE).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore, createPostgresStore, isPgAlreadyExists, PG_TABLES } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-load-${t}-`));
const PG = process.env.POA_DICE_TEST_PG_URL;

async function boot({ mock, bank, store, tag, bind = true }) {
  const bankEnv = { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1' };
  if (bind) bankEnv.POA_DICE_BIND_STORE = bank.address;
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv,
    storeEnv: {},
    settlementStore: store,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    loadRetryBaseMs: 10,
    loadRetryMaxMs: 40
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    await app.settlement.idle();
  };
  const get = async (p) => (await fetch(`${info.url}${p}`)).json();
  return { app, url: info.url, settle, get, close: () => app.close() };
}

const tx = (mock, wallet, to, amount, memo) => buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents() });

/** Async wrapper around a store whose load() fails `failures` times (Infinity = always) with the prod error. */
function flakyLoad(inner, failures) {
  let left = failures;
  const s = Object.create(inner);
  Object.assign(s, inner);
  s.async = true;
  s.loadCalls = 0;
  s.load = async () => {
    s.loadCalls += 1;
    if (left > 0) {
      left -= 1;
      throw Object.assign(new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'), { code: '23505' });
    }
    return inner.load();
  };
  return s;
}

/** A live vault (deposit booked) whose stored document a new instance will load. */
async function liveVault(mock, bank, p) {
  const live = await boot({ mock, bank, store: createMemoryStore(null), tag: 'live' });
  mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  await live.settle();
  const doc = live.app.settlement.store.load();
  await live.close();
  return doc;
}

test('load fails at startup (prod error), then succeeds: read-only meanwhile, then binds via POA_DICE_BIND_STORE and becomes LEADER without a restart', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const doc = await liveVault(mock, bank, p);
  const store = flakyLoad(createMemoryStore(doc), 3); // fresh claims: unbound, like prod after the deploy
  const srv = await boot({ mock, bank, store, tag: 'flaky' });
  try {
    let h = await srv.get('/api/health');
    assert.equal(h.settlement.status, 'SETTLEMENT_STORE_ERROR');
    assert.equal(h.settlement.readOnly, true);
    assert.equal(h.settlement.trading, 'READ_ONLY');
    assert.equal(h.settlement.vaultLoad.status, 'FAILED');
    assert.match(h.settlement.vaultLoad.lastError, /pg_type_typname_nsp_index/);
    assert.equal(srv.app.settlement.writer.lease, null, 'no lease before the vault is loaded');
    await srv.settle(10);
    const s = await srv.get('/api/settlement');
    assert.equal(s.vaultLoad.status, 'LOADED');
    assert.equal(s.vaultLoad.failures, 3);
    assert.ok(s.vaultLoad.retries >= 3, JSON.stringify(s.vaultLoad));
    assert.equal(s.writer.status, 'LEADER', JSON.stringify(s.writer));
    assert.equal(s.writer.binding.via, 'env');
    h = await srv.get('/api/health');
    assert.equal(h.settlement.readOnly, false);
    assert.notEqual(h.settlement.trading, 'READ_ONLY');
    mock.directSubmit(tx(mock, p, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' })).body);
    await srv.settle(8);
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'signing works normally after the delayed load (paid exactly once)');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('load keeps failing: stays read-only forever, retries with backoff, never binds, rolls or signs', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const doc = await liveVault(mock, bank, p);
  const store = flakyLoad(createMemoryStore(doc), Infinity);
  const srv = await boot({ mock, bank, store, tag: 'down' });
  try {
    const b = tx(mock, p, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 9500, clientSeed: 'never' }));
    mock.directSubmit(b.body);
    mock.directSubmit(tx(mock, p, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' })).body);
    await srv.settle(10);
    const s = await srv.get('/api/settlement');
    assert.equal(s.vaultLoad.status, 'FAILED');
    assert.ok(s.vaultLoad.failures >= 3, JSON.stringify(s.vaultLoad));
    assert.ok(store.loadCalls < 20, `backoff limits retries (${store.loadCalls})`);
    assert.equal(s.writer.status, 'UNBOUND');
    assert.equal(s.writer.lease, null, 'never took the lease');
    assert.equal(await store.peek('store-binding'), null, 'never bound');
    assert.equal(srv.app.engine.processedTxids.has(b.id), false, 'bet not rolled');
    assert.equal(mock.transfersFrom(bank.address).length, 0, 'nothing signed');
    const h = await srv.get('/api/health');
    assert.equal(h.settlement.readOnly, true);
    assert.equal(h.settlement.trading, 'READ_ONLY');
    const sub = await fetch(`${srv.url}/api/tx/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tx: tx(mock, p, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 5000, clientSeed: 'x' })) }) });
    assert.equal(sub.status, 503, 'new money-moving txs refused');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('postgres setup: an "already exists" race (23505 / 42P07 / 42710) is treated as success once the tables are verified', async () => {
  assert.equal(isPgAlreadyExists({ code: '23505' }), true);
  assert.equal(isPgAlreadyExists({ code: '42P07' }), true);
  assert.equal(isPgAlreadyExists({ code: '42710' }), true);
  assert.equal(isPgAlreadyExists({ code: '08006' }), false);
  const mk = (tablesPresent) => {
    const seen = [];
    const query = async (sql) => {
      seen.push(sql);
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/^CREATE TABLE/.test(sql)) throw Object.assign(new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'), { code: '23505' });
      if (/pg_catalog\.pg_tables/.test(sql)) return { rows: [{ n: tablesPresent }] };
      if (/SELECT doc FROM poa_dice_docs/.test(sql)) return { rows: [] };
      throw new Error(`unexpected sql ${sql}`);
    };
    return { store: createPostgresStore({ connectionString: 'postgres://fake', key: 'k', query }), seen };
  };
  const ok = mk(PG_TABLES.length);
  assert.equal(await ok.store.load(), null);
  assert.ok(ok.seen[0].includes('pg_advisory_xact_lock'), 'schema setup takes the advisory lock first');
  const bad = mk(PG_TABLES.length - 1);
  await assert.rejects(bad.store.load(), /schema incomplete/);
  const other = createPostgresStore({
    connectionString: 'postgres://fake',
    key: 'k',
    query: async (sql) => {
      if (/pg_advisory_xact_lock/.test(sql)) throw Object.assign(new Error('connection lost'), { code: '08006' });
      return { rows: [] };
    }
  });
  await assert.rejects(other.load(), /connection lost/, 'other errors are not swallowed');
});

test('real Postgres: 8 stores initializing the same empty database at once all load; the tables exist once', { skip: !PG }, async () => {
  const { default: pg } = await import('pg');
  const adminUrl = PG;
  const db = `poa_dice_race_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  const stores = Array.from({ length: 8 }, (_, i) => createPostgresStore({ connectionString: url.toString(), key: `race-${i % 2}:vault` }));
  try {
    const res = await Promise.allSettled(stores.map((s) => s.load()));
    const failed = res.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
    assert.deepEqual(failed, [], 'every concurrent first boot loads');
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    const r = await c.query('SELECT tablename FROM pg_tables WHERE tablename = ANY($1::text[]) ORDER BY 1', [PG_TABLES]);
    assert.deepEqual(r.rows.map((x) => x.tablename), [...PG_TABLES].sort());
    await c.end();
    // and the stores work: lease + fenced save on the fresh schema
    const l = await stores[0].lease('bank-writer', 'A', 30000);
    assert.equal(l.held, true);
  } finally {
    await Promise.all(stores.map((s) => s.close()));
    await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});

test('real Postgres: a server whose first load hits a fresh empty database with a concurrent peer binds and leads; the peer stands by', { skip: !PG }, async () => {
  const { default: pg } = await import('pg');
  const db = `poa_dice_boot_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: PG });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(PG);
  url.pathname = `/${db}`;
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const key = 'poa-dice:boot:vault';
  const [a, b] = await Promise.all([
    boot({ mock, bank, store: createPostgresStore({ connectionString: url.toString(), key }), tag: 'pg-a' }),
    boot({ mock, bank, store: createPostgresStore({ connectionString: url.toString(), key }), tag: 'pg-b' })
  ]);
  try {
    await Promise.all([a.settle(3), b.settle(3)]);
    const st = [a.app.settlement.writer.status, b.app.settlement.writer.status].sort();
    assert.deepEqual(st, ['LEADER', 'STANDBY']);
    for (const s of [a, b]) assert.equal(s.app.settlement.vaultLoad.status, 'LOADED');
  } finally {
    await a.close();
    await b.close();
    await a.app.settlement.store.close();
    await b.app.settlement.store.close();
    await mock.close();
    await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});
