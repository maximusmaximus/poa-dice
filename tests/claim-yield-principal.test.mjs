// @ts-nocheck
/**
 * tests/claim-yield-principal.test.mjs
 *
 * Regression suite for:
 *  - C-02: bank_claim_yield must never drain LP principalDepositedMicros / principalWithdrawnMicros.
 *          Claiming yield burns shares worth net gain, records yieldWithdrawnMicros, leaves principal intact,
 *          and allows subsequent yield claims as new house profits accrue.
 *  - Proportional principal accounting on subsequent bank_withdraw.
 *  - POA_DICE_DEV_FEE_MODE ('gross_and_earnings' vs 'net_profit_only') conservation & invariants.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { BankrollEngine, DEV_RESERVE_ADDRESS } from '../src/bankroll-engine.mjs';
import { genKeypair, toMicros } from '../src/crypto-poa.mjs';

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-claim-yield-${tag}-`));
}

let rpcSeq = 0;
async function mcpCall(url, name, args = {}) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcSeq,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text || '{}';
  return { isError: Boolean(body.result?.isError), data: JSON.parse(text) };
}

test('C-02: bank_claim_yield preserves principal across multiple profit cycles and subsequent partial withdraw', async () => {
  const dataDir = makeTempDir('cycles');
  const app = createDiceServer({
    dataDir,
    initialBootstrapPoa: null,
  });
  const info = await app.listen(0, '127.0.0.1');

  try {
    const lp = genKeypair();
    const bettor = genKeypair();

    // 1. LP stakes 1,000.000000 POA
    const stakeRes = await mcpCall(info.url, 'bank_stake', {
      amount_poa: '1000.000000',
      lock_epochs: 0,
      max_total_spend_poa: '1000.000000',
      privkey: lp.privkey,
    });
    assert.equal(stakeRes.isError, false, JSON.stringify(stakeRes.data));

    // Before any profit, claiming yield fails with no_yield
    const earlyClaim = await mcpCall(info.url, 'bank_claim_yield', {
      dry_run: true,
      address: lp.address,
    });
    assert.equal(earlyClaim.isError, true);
    assert.equal(earlyClaim.data.code, 'no_yield');

    // Helper: force house profit via Kelly-compliant bets (2.000000 POA at 50% win chance -> ~1.96 POA max profit <= 10 POA Kelly cap)
    const generateHouseProfit = async (cycleTag) => {
      const navStart = app.engine.bankNavMicros;
      for (let i = 0; i < 80 && app.engine.bankNavMicros <= navStart; i++) {
        const r = await mcpCall(info.url, 'dice_batch_roll', {
          count: 1,
          amount_poa: '2.000000',
          target_bps: 5000,
          direction: 'under',
          client_seed: `${cycleTag}-${i}`,
          max_total_spend_poa: '2.000000',
          privkey: bettor.privkey,
        });
        assert.equal(r.isError, false, JSON.stringify(r.data));
      }
      assert.ok(app.engine.bankNavMicros > navStart, 'house NAV increased from losing bet(s)');
    };

    // 2. Profit Cycle #1 -> Claim Yield #1
    await generateHouseProfit('cycle1');
    const claim1 = await mcpCall(info.url, 'bank_claim_yield', {
      privkey: lp.privkey,
    });
    assert.equal(claim1.isError, false, JSON.stringify(claim1.data));
    assert.equal(claim1.data.action, 'LP_WITHDRAW');
    const claimed1Micros = toMicros(claim1.data.netPayoutPoa);
    assert.ok(claimed1Micros > 0n, 'claimed positive yield in cycle 1');

    let posView = app.engine.getLpPosition(lp.address);
    assert.equal(posView.principalDepositedPoa, '1000.000000', 'principalDepositedPoa unchanged');
    assert.equal(posView.principalWithdrawnPoa, '0.000000', 'principalWithdrawnPoa MUST stay 0 on yield claim');
    assert.equal(posView.netPrincipalPoa, '1000.000000', 'netPrincipalPoa MUST stay 1,000.000000 POA');
    assert.equal(toMicros(posView.yieldWithdrawnPoa) > 0n, true, 'yieldWithdrawnPoa tracks claimed yield');

    // Advance epoch so no residual early-exit fee dust remains above principal, then verify repeat claim refuses with no_yield
    app.engine.advanceEpoch({ distributeIncentives: false });
    const drainResidual = await mcpCall(info.url, 'bank_claim_yield', { privkey: lp.privkey });
    if (!drainResidual.isError) {
      posView = app.engine.getLpPosition(lp.address);
      assert.equal(posView.principalWithdrawnPoa, '0.000000', 'principalWithdrawnPoa still 0');
    }
    const repeatClaim = await mcpCall(info.url, 'bank_claim_yield', {
      privkey: lp.privkey,
    });
    assert.equal(repeatClaim.isError, true, 'must reject repeat claim when position value is at principal');
    assert.equal(repeatClaim.data.code, 'no_yield');

    // 3. Profit Cycle #2 -> Claim Yield #2
    await generateHouseProfit('cycle2');
    const claim2 = await mcpCall(info.url, 'bank_claim_yield', {
      privkey: lp.privkey,
    });
    assert.equal(claim2.isError, false, JSON.stringify(claim2.data));
    assert.equal(claim2.data.action, 'LP_WITHDRAW');

    posView = app.engine.getLpPosition(lp.address);
    assert.equal(posView.principalDepositedPoa, '1000.000000');
    assert.equal(posView.principalWithdrawnPoa, '0.000000', 'still zero principal withdrawn after 2 yield claims');
    assert.equal(posView.netPrincipalPoa, '1000.000000');
    const totalYieldMicros = toMicros(posView.yieldWithdrawnPoa);
    assert.ok(totalYieldMicros > claimed1Micros, 'cumulative yieldWithdrawnPoa grew on second claim');

    // 4. Subsequent 50% (5000 bps) bank_withdraw reduces principal proportionally by ~500 POA
    const wd = await mcpCall(info.url, 'bank_withdraw', {
      mode: 'BPS',
      bps: 5000,
      privkey: lp.privkey,
    });
    assert.equal(wd.isError, false, JSON.stringify(wd.data));
    assert.equal(wd.data.action, 'LP_WITHDRAW');

    posView = app.engine.getLpPosition(lp.address);
    const principalWithdrawn = toMicros(posView.principalWithdrawnPoa);
    // 5000 bps of 1000 POA principal = 500 POA (within tiny exit-fee/rounding tolerance)
    assert.ok(
      principalWithdrawn >= 499_000_000n && principalWithdrawn <= 500_000_000n,
      `expected ~500 POA principal withdrawn, got ${posView.principalWithdrawnPoa}`
    );
    assert.ok(toMicros(posView.yieldWithdrawnPoa) >= totalYieldMicros, 'yieldWithdrawnPoa preserved after partial withdraw');
    assert.equal(app.engine.verifySystemInvariants().ok, true);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('devFeeMode: net_profit_only charges 0 dev fee on player wins and 10 bps on player losses', () => {
  const dataDir = makeTempDir('dev-fee-mode');
  try {
    const engine = new BankrollEngine({
      dataDir,
      initialBootstrapPoa: '50000.000000',
      bootstrapAddress: DEV_RESERVE_ADDRESS,
      devFeeMode: 'net_profit_only',
    });

    const player = genKeypair();
    const q = engine.quoteBet({
      address: player.address,
      amountPoa: '100.000000',
      direction: 'under',
      targetBps: 9500,
    });
    assert.equal(q.valid, true);
    assert.equal(q.devFeeMode, 'net_profit_only');
    assert.equal(q.devFeeOnWinPoa, '0.000000');
    assert.equal(q.devReserveFeePoa, '0.100000');

    let sawWin = false;
    let sawLoss = false;
    for (let i = 0; i < 60 && (!sawWin || !sawLoss); i++) {
      const targetBps = !sawWin ? 9500 : 2500;
      const r = engine.placeAndSettleBet({
        betTxid: `${(i + 1).toString(16).padStart(64, '0')}`,
        address: player.address,
        amountPoa: '100.000000',
        direction: 'under',
        targetBps,
        clientSeed: `fee-mode-${i}`,
      });
      if (r.won) {
        sawWin = true;
        assert.equal(r.devFeeReservedPoa, '0.000000', 'winning bet must reserve 0 dev fee in net_profit_only mode');
      } else {
        sawLoss = true;
        assert.equal(r.devFeeReservedPoa, '0.100000', 'losing bet reserves 0.1% (0.100000 POA) dev fee');
      }
    }
    assert.equal(sawWin, true, 'observed at least one win');
    assert.equal(sawLoss, true, 'observed at least one loss');
    assert.equal(engine.verifySystemInvariants().ok, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
