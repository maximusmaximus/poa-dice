// @ts-nocheck
/**
 * fix/single-writer-bank. On 2026-10-25 at 8:36 PM PT a second copy of the server, holding the bank key
 * but not the shared vault store, re-rolled bets that were already booked as losses and paid "wins"
 * (9161f423…, 9058932d…, 6755f9b2…). These tests pin the fail-closed rules: signing needs the explicit
 * signer flag, a store bound to the bank, and the single-writer lease; ledger-only bets are never rolled;
 * a bet already paid on chain is never paid again; unexpected bank outflows hold trading.
 * Everything runs against the local mock minepoa; nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros, fromMicros } from '../src/crypto-poa.mjs';
import { computeRoll } from '../src/provably-fair.mjs';
import { createMemoryStore, createClaimTable, leaseBook } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-writer-${t}-`));
const ADMIN = 'writer-test-admin';

async function boot({ mock, bank, store = createMemoryStore(null), tag, signer = true, bind = true, env = {} }) {
  const bankEnv = { POA_DICE_BANK_PRIVKEY: bank.privkey, ...env };
  if (signer) bankEnv.POA_DICE_BANK_SIGNER = '1';
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
    adminToken: ADMIN
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 15));
    }
    await app.settlement.idle();
  };
  const get = async (p) => (await fetch(`${info.url}${p}`)).json();
  const admin = async (p, body) => {
    const r = await fetch(`${info.url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, url: info.url, settle, get, admin, store, close: () => app.close() };
}

const ts = (ago = 0) => Math.floor(Date.now() / 1000) - ago;
const tx = (mock, wallet, to, amount, memo, t = ts()) => buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), ts: t });
const bet = (mock, p, bank, seed, target = 5000, t = ts()) => tx(mock, p, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: target, clientSeed: seed }), t);

test('signer flag off: the bank key alone never signs, never rolls, and trading is held read-only', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'off', signer: false });
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', 'DICE1:LP_ADD').body);
    const b = bet(mock, p, bank, 'flag-off');
    mock.directSubmit(b.body);
    await srv.settle();
    assert.equal(srv.app.settlement.writer.status, 'DISABLED');
    assert.equal(srv.app.engine.processedTxids.has(b.id), false, 'bet not rolled');
    assert.equal(mock.transfersFrom(bank.address).length, 0, 'nothing signed');
    const h = await srv.get('/api/health');
    assert.equal(h.settlement.trading, 'READ_ONLY');
    assert.equal(h.settlement.writer.status, 'DISABLED');
    const bind = await srv.admin('/api/admin/store-binding', { bankAddress: bank.address });
    assert.equal(bind.status, 409, 'binding refused while the flag is off');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('empty store + prod bank key + ledger history (a preview or stale copy): never binds, never signs, never rolls', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  // the live vault's history: a deposit and a bet that the live vault already booked as a loss
  mock.directSubmit(tx(mock, p, bank.address, '20.000000', 'DICE1:LP_ADD', ts(600)).body);
  const old = bet(mock, p, bank, 'booked-elsewhere', 5000, ts(300));
  mock.directSubmit(old.body);
  const srv = await boot({ mock, bank, tag: 'empty' });
  try {
    const fresh = bet(mock, p, bank, 'arrives-later');
    mock.directSubmit(fresh.body);
    await srv.settle(6);
    assert.equal(srv.app.settlement.writer.status, 'UNBOUND');
    assert.match(srv.app.settlement.lastError, /refusing to bind/);
    assert.equal(await srv.store.peek('store-binding'), null, 'no binding row created');
    assert.equal(srv.app.engine.processedTxids.has(old.id), false, 'old bet never re-rolled');
    assert.equal(srv.app.engine.processedTxids.has(fresh.id), false, 'new bet never rolled by this copy');
    assert.equal(mock.transfersFrom(bank.address).length, 0, 'the bank signed nothing');
    assert.equal(srv.store.load(), null, 'a read-only copy never writes the vault document');
    assert.equal((await srv.get('/api/health')).settlement.trading, 'READ_ONLY');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('stale copy of the store (does not know the newest bank outflow): binding refused', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const live = await boot({ mock, bank, tag: 'live', bind: false });
  try {
    // unbound + no history yet: an explicit admin binding works
    const ok = await live.admin('/api/admin/store-binding', { bankAddress: bank.address });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(live.app.settlement.writer.status, 'LEADER');
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    await live.settle();
    const snapshot = JSON.parse(JSON.stringify(live.store.load())); // an old backup of the vault
    mock.directSubmit(tx(mock, p, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' })).body);
    await live.settle(8);
    assert.equal(mock.transfersFrom(bank.address).length, 1);
    const stale = await boot({ mock, bank, store: createMemoryStore(snapshot), tag: 'stale' });
    try {
      await stale.settle(3);
      assert.equal(stale.app.settlement.writer.status, 'UNBOUND', JSON.stringify([stale.app.settlement.writer.view(), stale.app.settlement.lastError, Object.keys(snapshot.ledgerOut || {}), mock.transfersFrom(bank.address).map((t) => t.id)]));
      assert.match(stale.app.settlement.lastError, /not the live store/);
      assert.equal(mock.transfersFrom(bank.address).length, 1, 'no second payout');
    } finally {
      await stale.close();
    }
  } finally {
    await live.close();
    await mock.close();
  }
});

test('second instance without the lease is read-only; after the writer stops it takes over from the shared document without re-rolling', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const shared = createMemoryStore(null); // one shared database
  const a = await boot({ mock, bank, store: shared, tag: 'a' });
  const b = await boot({ mock, bank, store: shared, tag: 'b' });
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    await a.settle();
    await b.settle();
    assert.equal(a.app.settlement.writer.status, 'LEADER');
    assert.equal(b.app.settlement.writer.status, 'STANDBY');
    assert.equal(b.app.settlement.writer.canWrite(), false, 'the standby never signs');
    assert.equal(b.app.settlement.tradingHold(), null, 'the standby follows the writer\'s published status (open)');
    const x = bet(mock, p, bank, 'shared-store', 9500);
    mock.directSubmit(x.body);
    for (let i = 0; i < 6; i++) await Promise.all([a.app.settlement.tick(), b.app.settlement.tick()]);
    await Promise.all([a.app.settlement.idle(), b.app.settlement.idle()]);
    const ra = a.app.engine.processedTxids.get(x.id);
    assert.ok(ra, 'the writer rolled the bet');
    assert.equal(b.app.settlement.writer.canWrite(), false, 'the standby did not roll it (it only mirrors the shared books)');
    const mirrored = b.app.engine.processedTxids.get(x.id);
    if (mirrored) assert.equal(mirrored.rollBps, ra.rollBps, 'the standby mirror shows the writer\'s roll');
    const sentBefore = mock.transfersFrom(bank.address).length;
    await a.close(); // releases the lease
    await b.settle(6);
    assert.equal(b.app.settlement.writer.status, 'LEADER');
    const rb = b.app.engine.processedTxids.get(x.id);
    assert.ok(rb, 'new writer loaded the shared books');
    assert.equal(rb.rollBps, ra.rollBps, 'same roll, never re-rolled');
    assert.equal(mock.transfersFrom(bank.address).length, sentBefore, 'never paid twice');
  } finally {
    await b.close();
    await mock.close();
  }
});

test('lease book: one holder at a time, renewals keep the token, takeover after expiry bumps the fencing token', () => {
  const book = {};
  const t0 = 1_000_000;
  const a1 = leaseBook(book, 'A', 30000, t0);
  assert.equal(a1.held, true);
  assert.equal(leaseBook(book, 'B', 30000, t0 + 1000).held, false, 'B cannot take a live lease');
  const a2 = leaseBook(book, 'A', 30000, t0 + 2000);
  assert.equal(a2.token, a1.token, 'renewal keeps the token');
  const b1 = leaseBook(book, 'B', 30000, t0 + 40000);
  assert.equal(b1.held, true);
  assert.ok(b1.token > a1.token, 'takeover gets a higher fencing token');
  assert.equal(leaseBook(book, 'A', 30000, t0 + 41000).held, false, 'old holder is fenced off');
});

test('postgres: vault writes are fenced by the lease token (a writer that lost the lease cannot overwrite the document)', async () => {
  const { createPostgresStore } = await import('../src/settlement-store.mjs');
  const leases = new Map();
  const docs = new Map();
  const query = async (sql, params) => {
    if (/^\s*CREATE TABLE/.test(sql)) return { rows: [] };
    if (/INSERT INTO poa_dice_leases/.test(sql)) {
      const [key, holder, ms] = params;
      const cur = leases.get(key);
      const nowMs = Date.now();
      if (cur && cur.holder !== holder && cur.expires > nowMs) return { rows: [] };
      const token = cur ? (cur.holder === holder && cur.expires > nowMs ? cur.token : cur.token + 1) : 1;
      leases.set(key, { holder, token, expires: nowMs + Number(ms) });
      return { rows: [{ holder, token: String(token), expires_at: new Date(nowMs + Number(ms)) }] };
    }
    if (/INSERT INTO poa_dice_docs/.test(sql) && /WHERE EXISTS/.test(sql)) {
      const [key, value, lname, holder, token] = params;
      const l = leases.get(lname);
      if (!l || l.holder !== holder || String(l.token) !== String(token) || l.expires <= Date.now()) return { rows: [] };
      docs.set(key, JSON.parse(value));
      return { rows: [{ key }] };
    }
    if (/INSERT INTO poa_dice_docs/.test(sql)) {
      docs.set(params[0], JSON.parse(params[1]));
      return { rows: [] };
    }
    if (/SELECT value FROM poa_dice_docs/.test(sql)) return { rows: docs.has(params[0]) ? [{ value: docs.get(params[0]) }] : [] };
    if (/DELETE FROM poa_dice_leases|UPDATE poa_dice_leases/.test(sql)) {
      leases.delete(params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  };
  const s = createPostgresStore({ connectionString: 'postgres://fake', key: 'vault', query });
  const lease = await s.lease('bank-writer', 'A', 30000);
  assert.equal(lease.held, true);
  s.setFence({ name: 'bank-writer', holder: 'A', token: lease.token });
  await s.save({ version: 1, n: 1 });
  assert.equal(docs.get('vault').n, 1, 'leader write lands');
  s.setFence({ name: 'bank-writer', holder: 'A', token: Number(lease.token) + 99 });
  await assert.rejects(s.save({ version: 1, n: 2 }), /fenced/);
  assert.equal(docs.get('vault').n, 1, 'fenced write did not land');
  s.setFence({ name: 'bank-writer', holder: 'A', token: -1 });
  await assert.rejects(s.save({ version: 1, n: 3 }), /fenced/);
});

test('bet found only on the ledger (older than the store binding): held for review, not rolled, not paid, listed in the audit', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  mock.directSubmit(tx(mock, p, bank.address, '20.000000', 'DICE1:LP_ADD', ts(600)).body);
  const old = bet(mock, p, bank, 'ledger-only', 9500, ts(300));
  mock.directSubmit(old.body);
  const srv = await boot({ mock, bank, tag: 'ledger-only', bind: false });
  try {
    const refused = await srv.admin('/api/admin/store-binding', { bankAddress: bank.address });
    assert.equal(refused.status, 409, 'empty store + history: plain binding refused');
    const rec = await srv.admin('/api/admin/store-binding', { bankAddress: bank.address, recovery: true });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    assert.equal(rec.body.binding.recovery, true);
    await srv.settle(6);
    const st = await srv.get(`/api/tx/${old.id}/status`);
    assert.equal(st.rawStatus, 'NEEDS_REVIEW', JSON.stringify(st));
    assert.equal(srv.app.engine.processedTxids.has(old.id), false, 'not rolled');
    assert.equal(mock.transfersFrom(bank.address).length, 0, 'not paid');
    const audit = await srv.get('/api/audit/chain');
    const listed = audit.ledgerOnlyBets.find((b) => b.txid === old.id);
    assert.ok(listed, JSON.stringify(audit.ledgerOnlyBets));
    assert.ok(['LEDGER_ONLY_BET', 'PREDATES_STATE'].includes(listed.reason), listed.reason);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('WIN already paid on chain by another signer: the vault refuses to pay it again (REFUSED_DUPLICATE)', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'dup' });
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    await srv.settle();
    const seed = srv.app.engine.seedManager.currentSeed;
    let win;
    for (let i = 0; i < 50 && !win; i++) {
      const cand = bet(mock, p, bank, `dup-${i}`, 9500);
      if (computeRoll({ serverSeed: seed, clientSeed: `dup-${i}`, nonce: 1, betTxid: cand.id }).rollBps < 9500) win = cand;
    }
    assert.ok(win);
    // another copy with the bank key pays this bet first (no ord tag, different amount)
    const rogue = tx(mock, bank, p.address, '1.500000', `DICE1:WIN:${win.id.slice(0, 16)}:roll=12.34`);
    mock.directSubmit(rogue.body);
    mock.directSubmit(win.body);
    await srv.settle(8);
    const booked = srv.app.engine.processedTxids.get(win.id);
    assert.ok(booked && booked.won, 'the vault rolled its accepted bet (a win)');
    const outs = mock.transfersFrom(bank.address);
    assert.equal(outs.length, 1, 'only the rogue transfer; the vault did not pay again');
    assert.equal(outs[0].id, rogue.id);
    const audit = await srv.get('/api/audit/chain');
    assert.equal(audit.refusedDuplicatePayouts.length, 1, JSON.stringify(Object.values(srv.app.settlement.state.outbound).map((o) => [o.status, o.memo, o.lastError])));
    assert.equal(audit.refusedDuplicatePayouts[0].duplicateOf, rogue.id);
    assert.ok(audit.foreignOutflows.some((f) => f.txid === rogue.id), 'the rogue payout is a foreign outflow');
    assert.notEqual((await srv.get('/api/health')).settlement.trading, 'OPEN');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('foreign payouts (incident style) raise an alarm that holds trading until an operator acknowledges them', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  const tess = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'foreign' });
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    await srv.settle();
    assert.equal((await srv.get('/api/health')).settlement.trading, 'OPEN');
    const rogue = [];
    for (const [to, amt, memo] of [
      [tess.address, '2.002424', 'DICE1:WIN:6a696d248df8533d:roll=88.41'],
      [p.address, '3.961584', 'DICE1:WIN:fd08906b0d6d5dd9:roll=83.42']
    ]) {
      const r = tx(mock, bank, to, amt, memo);
      mock.directSubmit(r.body);
      rogue.push(r);
    }
    await srv.settle();
    const h = await srv.get('/api/health');
    assert.equal(h.settlement.trading, 'HOLD');
    assert.ok(['SOLVENCY_HOLD', 'FOREIGN_OUTFLOW_HOLD'].includes(h.settlement.reconcile.status), h.settlement.reconcile.status);
    assert.deepEqual(h.settlement.foreignOutflows.map((f) => f.txid).sort(), rogue.map((r) => r.id).sort());
    let audit = await srv.get('/api/audit/chain');
    assert.equal(audit.foreignOutflowsOk, false);
    assert.equal(audit.ok, false);
    // unknown txid or bad mode: refused
    assert.equal((await srv.admin('/api/admin/foreign-outflows/ack', { txids: ['ff'.repeat(32)], mode: 'book_loss' })).status, 409);
    assert.equal((await srv.admin('/api/admin/foreign-outflows/ack', { txids: [rogue[0].id], mode: 'ignore' })).status, 409);
    const ack = await srv.admin('/api/admin/foreign-outflows/ack', { txids: rogue.map((r) => r.id), mode: 'book_loss' });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    await srv.settle();
    audit = await srv.get('/api/audit/chain');
    assert.equal(audit.foreignOutflowsOk, true);
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.equal(fromMicros(srv.app.engine.bankNavMicros), fromMicros(toMicros('20.000000') - toMicros('2.002424') - toMicros('3.961584')));
    assert.equal((await srv.get('/api/health')).settlement.trading, 'OPEN');
    assert.equal(mock.transfersFrom(bank.address).length, 2, 'the vault itself sent nothing');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('one store, one bank: a store bound to another bank stays read-only', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const other = genKeypair();
  const store = createMemoryStore(null, { claims: createClaimTable() });
  store.claim('store-binding', { bankAddress: other.address, storeId: 'store-x', boundAt: new Date().toISOString(), boundAtMs: Date.now() });
  const srv = await boot({ mock, bank, store, tag: 'mismatch' });
  try {
    await srv.settle(2);
    assert.equal(srv.app.settlement.writer.status, 'BINDING_MISMATCH');
    assert.equal((await srv.get('/api/health')).settlement.trading, 'READ_ONLY');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('Vercel preview deployment with the prod bank key and the flag set: still read-only', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const srv = await boot({ mock, bank, tag: 'preview', env: { VERCEL_ENV: 'preview' } });
  try {
    await srv.settle(2);
    assert.equal(srv.app.settlement.writer.status, 'NOT_PRODUCTION');
    assert.equal(await srv.store.peek('store-binding'), null, 'a preview never creates the binding');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('copy of the production database (e.g. a preview branch): binding and lease rows copied, but the copy misses later bank transfers => STALE_STORE, never signs', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const prod = await boot({ mock, bank, tag: 'prod' });
  let copy;
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    await prod.settle();
    // the database is copied (doc + claims incl. binding), then production keeps paying
    const claims = createClaimTable();
    for (const [k, v] of prod.store.claims) if (!k.startsWith('__lease__')) claims.set(k, typeof v === 'string' ? v : structuredClone(v));
    const copyStore = createMemoryStore(prod.store.load(), { claims });
    mock.directSubmit(tx(mock, p, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' })).body);
    await prod.settle(8);
    const paid = mock.transfersFrom(bank.address).length;
    assert.equal(paid, 1, 'production paid the withdrawal');
    copy = await boot({ mock, bank, store: copyStore, tag: 'copy' });
    const later = bet(mock, p, bank, 'after-copy', 9500);
    mock.directSubmit(later.body);
    await copy.settle(4);
    assert.equal(copy.app.settlement.writer.status, 'STALE_STORE', JSON.stringify(copy.app.settlement.writer.view()));
    assert.equal(copy.app.engine.processedTxids.has(later.id), false, 'the copy never rolls');
    assert.equal(mock.transfersFrom(bank.address).length, paid, 'the copy never signs');
    assert.match(copy.app.settlement.writer.blocked?.reason || '', /does not account for bank transfer/);
  } finally {
    if (copy) await copy.close();
    await prod.close();
    await mock.close();
  }
});

test('seed commitment: a bet is rolled only with the server seed committed when it was accepted', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: false });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'seed' });
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    mock.finalizeAll();
    await srv.settle();
    const small = (seed) => tx(mock, p, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 9500, clientSeed: seed }));
    const kept = small('seed-kept');
    mock.directSubmit(kept.body);
    await srv.settle(2); // seen, not final yet: accepted with the current commitment
    const commit = srv.app.settlement.state.inbound[kept.id]?.seedCommit;
    assert.ok(commit && commit.hash === srv.app.engine.seedManager.currentSeedHash, JSON.stringify(commit));
    mock.finalizeAll();
    await srv.settle();
    const r = srv.app.engine.processedTxids.get(kept.id);
    assert.equal(r.provablyFair.serverSeedHash, commit.hash, 'rolled with the stored commitment');

    const moved = small('seed-moved');
    mock.directSubmit(moved.body);
    await srv.settle(2);
    assert.ok(srv.app.settlement.state.inbound[moved.id]?.seedCommit);
    const rot = await srv.admin('/api/seed/rotate', {});
    assert.equal(rot.status, 200);
    mock.finalizeAll();
    await srv.settle();
    const st = await srv.get(`/api/tx/${moved.id}/status`);
    assert.equal(st.rawStatus, 'NEEDS_REVIEW', JSON.stringify(st));
    assert.equal(srv.app.engine.processedTxids.has(moved.id), false, 'never rolled with a different seed');
  } finally {
    await srv.close();
    await mock.close();
  }
});

// Real Postgres (opt-in): POA_DICE_TEST_PG_URL=postgres://... npm test
test('real Postgres: two servers on one database => one writer; an empty key in the same database stays unbound', { skip: !process.env.POA_DICE_TEST_PG_URL }, async () => {
  const { createPostgresStore } = await import('../src/settlement-store.mjs');
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const key = `test-${Date.now()}-${Math.random().toString(16).slice(2)}:vault`;
  const mk = (k) => createPostgresStore({ connectionString: process.env.POA_DICE_TEST_PG_URL, key: k });
  const a = await boot({ mock, bank, store: mk(key), tag: 'pg-a' });
  const b = await boot({ mock, bank, store: mk(key), tag: 'pg-b' });
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    await a.settle();
    await b.settle();
    assert.deepEqual([a.app.settlement.writer.status, b.app.settlement.writer.status].sort(), ['LEADER', 'STANDBY']);
    const other = await boot({ mock, bank, store: mk(`${key}-preview`), tag: 'pg-other' });
    try {
      await other.settle(2);
      assert.equal(other.app.settlement.writer.status, 'UNBOUND');
    } finally {
      await other.close();
    }
  } finally {
    await a.close();
    await b.close();
    await mock.close();
  }
});
