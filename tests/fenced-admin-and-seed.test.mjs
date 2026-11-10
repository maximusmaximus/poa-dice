// @ts-nocheck
/**
 * tests/fenced-admin-and-seed.test.mjs
 *
 * Regression suite for:
 *  - C-01: /api/seed/rotate, /api/dev/sweep, and /api/epoch/advance are fenced under the
 *          single-writer lease in chain mode (standbys refuse with 503 while another leader holds the lease,
 *          and leader mutations persist cleanly to the shared store).
 *  - C-03: /api/seed/rotate refuses with 409 IN_FLIGHT_BETS_OPEN while accepted bets are still unsettled
 *          on chain, preventing commitment mismatch holds on pre-rotation bets.
 *  - H-03: distributeEpochIncentives includes referrer bonus weight in totalWeight and mints exact
 *          dilution-adjusted shares so bankNavMicros and share invariants remain 100% conserved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { BankrollEngine, DEV_RESERVE_ADDRESS } from '../src/bankroll-engine.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const ADMIN = 'fenced-admin-secret-token';
const CRON = 'fenced-cron-secret-token';

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-fenced-${tag}-`));
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
  const settle = async (rounds = 4) => {
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

test('C-01 & C-03: admin mutations are fenced under writer lease and /api/seed/rotate blocks while bets are in flight', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: false });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '500.000000');
  const store = createMemoryStore(null);

  const leader = await bootNode({ mock, bank, store, tag: 'leader' });
  const standby = await bootNode({ mock, bank, store, tag: 'standby' });

  try {
    // Seed the bank with 100 POA LP stake and finalize it
    mock.directSubmit(
      signedTx(mock, player, bank.address, '100.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body
    );
    mock.finalizeAll();
    await leader.settle();
    await standby.settle(2);

    assert.equal(leader.s.writer.status, 'LEADER');
    assert.equal(standby.s.writer.status, 'STANDBY');

    // 1. Standby MUST refuse admin mutations with 503 SIGNER_READ_ONLY while leader holds active writer lease
    for (const endpoint of ['/api/seed/rotate', '/api/dev/sweep', '/api/epoch/advance']) {
      const denied = await standby.req(endpoint, { method: 'POST', auth: ADMIN });
      assert.equal(denied.status, 503, `standby ${endpoint} must refuse with 503: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.code, 'SIGNER_READ_ONLY');
    }

    // 2. Submit a player bet while autoFinal=false so the bet stays BROADCAST (in-flight)
    // (2500 target -> 3x net profit; 0.25 POA wager -> 0.75 POA profit <= 1.00 POA Kelly cap on 100 POA bank)
    const openBet = signedTx(
      mock,
      player,
      bank.address,
      '0.250000',
      formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 2500, clientSeed: 'inflight-bet' })
    );
    const subRes = await leader.req('/api/tx/submit', { method: 'POST', body: { tx: openBet } });
    assert.equal(subRes.status, 202, JSON.stringify(subRes.body));

    // C-03: /api/seed/rotate refuses with 409 IN_FLIGHT_BETS_OPEN while the bet is open!
    const seedHashBefore = leader.app.engine.seedManager.currentSeedHash;
    const blockedRotate = await leader.req('/api/seed/rotate', { method: 'POST', auth: ADMIN });
    assert.equal(blockedRotate.status, 409, JSON.stringify(blockedRotate.body));
    assert.equal(blockedRotate.body.code, 'IN_FLIGHT_BETS_OPEN');
    assert.equal(leader.app.engine.seedManager.currentSeedHash, seedHashBefore, 'seed did NOT rotate while bet open');

    // 3. Finalize the in-flight bet -> leader settles it cleanly against the committed seed!
    mock.finalizeAll();
    await leader.settle();
    const rec = leader.s.state.inbound[openBet.id];
    assert.equal(rec.status, 'BOOKED', `bet settled cleanly without commitment mismatch: ${JSON.stringify(rec)}`);

    // 4. Now with zero open bets, fenced /api/seed/rotate, /api/epoch/advance, and /api/dev/sweep succeed on leader!
    const okRotate = await leader.req('/api/seed/rotate', { method: 'POST', auth: ADMIN });
    assert.equal(okRotate.status, 200, JSON.stringify(okRotate.body));
    assert.notEqual(okRotate.body.nextServerSeedHash, seedHashBefore, 'seed rotated cleanly once bets settled');

    const okEpoch = await leader.req('/api/epoch/advance', { method: 'POST', auth: ADMIN });
    assert.equal(okEpoch.status, 200, JSON.stringify(okEpoch.body));
    assert.equal(okEpoch.body.ok, true);

    const okSweep = await leader.req('/api/dev/sweep', { method: 'POST', auth: ADMIN });
    assert.equal(okSweep.status, 200, JSON.stringify(okSweep.body));
    mock.finalizeAll();
    await leader.settle();

    // Verify shared store holds the rotated seed hash & advanced epoch
    await leader.s.flush();
    const stored = await store.load();
    assert.equal(stored.engine.seedState.currentSeedHash, okRotate.body.nextServerSeedHash);
    assert.equal(Number(stored.engine.currentEpoch), 2);
    assert.equal(leader.app.engine.verifySystemInvariants().ok, true);
  } finally {
    await standby.close();
    await leader.close();
    await mock.close();
  }
});

test('H-03: distributeEpochIncentives conserves exact pool NAV and share invariants when referrers are active', () => {
  const dataDir = makeTempDir('referral-incentives');
  try {
    const engine = new BankrollEngine({
      dataDir,
      initialBootstrapPoa: null,
      bootstrapAddress: DEV_RESERVE_ADDRESS,
    });

    const lp1 = genKeypair();
    const lp2 = genKeypair();
    const referrer = genKeypair();
    const bettor = genKeypair();

    // referrer stakes 1,000 POA; lp1 stakes 10,000 POA; lp2 stakes 10,000 POA locked 4 epochs WITH referrer
    engine.applyDeposit({
      txid: '0'.repeat(64),
      address: referrer.address,
      amountPoa: '1000.000000',
      lockEpochs: 0,
    });
    engine.applyDeposit({
      txid: '1'.repeat(64),
      address: lp1.address,
      amountPoa: '10000.000000',
      lockEpochs: 0,
    });
    engine.applyDeposit({
      txid: '2'.repeat(64),
      address: lp2.address,
      amountPoa: '10000.000000',
      lockEpochs: 4,
      referrer: referrer.address,
    });

    // Place 20 Kelly-compliant bets (20 POA at 25% -> ~60 POA profit <= 200 POA Kelly cap) so incentivePoolMicros accrues
    for (let i = 0; i < 20; i++) {
      engine.placeAndSettleBet({
        betTxid: `${(100 + i).toString(16).padStart(64, '0')}`,
        address: bettor.address,
        amountPoa: '20.000000',
        direction: 'under',
        targetBps: 2500,
        clientSeed: `incentive-${i}`,
      });
    }
    const poolBefore = engine.incentivePoolMicros;
    const navBefore = engine.bankNavMicros;
    assert.ok(poolBefore > 0n, 'incentivePoolMicros accrued');

    const dist = engine.advanceEpoch({ distributeIncentives: true });
    assert.equal(engine.currentEpoch, 2);
    // Exact conservation: NAV + remaining integer rounding dust in incentivePoolMicros === navBefore + poolBefore
    assert.ok(engine.incentivePoolMicros >= 0n && engine.incentivePoolMicros <= 5n, 'only sub-recipient integer dust remains');
    assert.equal(engine.bankNavMicros + engine.incentivePoolMicros, navBefore + poolBefore, 'exact pool + NAV conserved to the micro-POA');
    assert.ok(dist, 'advanceEpoch returned summary');

    // Referrer must hold bonus shares and referralEarnedMicros > 0
    const refPos = engine.lpPositions.get(referrer.address);
    assert.ok(refPos && refPos.referralEarnedMicros > 0n, 'referrer received referral bonus shares');

    // Sum of microsForShares across all positions cannot exceed bankNavMicros and only differs by integer rounding dust (< 10 micros)
    let sumRedeemable = 0n;
    let sumShares = 0n;
    for (const pos of engine.lpPositions.values()) {
      sumShares += pos.shares;
      sumRedeemable += engine.microsForShares(pos.shares);
    }
    assert.equal(sumShares, engine.totalShares, 'totalShares equals sum of all LP shares');
    const dust = engine.bankNavMicros - sumRedeemable;
    assert.ok(dust >= 0n && dust <= 10n, `expected 0..10 micros rounding dust, got ${dust}`);
    assert.equal(engine.verifySystemInvariants().ok, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
