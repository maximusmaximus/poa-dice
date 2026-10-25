// @ts-nocheck
/**
 * Stake lock-up warning: the page's confirmation copy must match what the engine does.
 *  - a lock applies to the whole position, so a locked stake also locks existing shares;
 *  - a lock-0 stake into a locked position joins that lock;
 *  - withdrawals (and yield claims) are refused until the lock-until epoch;
 *  - /api/state exposes the epoch clock (current, nominal length, start) used for the estimate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BankrollEngine } from '../src/bankroll-engine.mjs';
import { genKeypair } from '../src/crypto-poa.mjs';
import { stakeLockPlan, stakeLockCopy, formatLockDuration } from '../public/app.js';

const fixedDate = () => 'DATE';
const flat = (copy) => copy.body.map((b) => (typeof b === 'string' ? b : `${b.strong || ''}${b.text}`)).join('\n');

test('engine: lock is per position and blocks every withdrawal until lock-until epoch', () => {
  const engine = new BankrollEngine({ dataDir: null, initialBootstrapPoa: '1000.000000' });
  const a = genKeypair().address;
  engine.applyDeposit({ txid: 't1', address: a, amountPoa: '100.000000', lockEpochs: 0 });
  assert.equal(engine.quoteWithdraw({ address: a, bpsToRedeem: 10000 }).valid, true);
  engine.applyDeposit({ txid: 't2', address: a, amountPoa: '50.000000', lockEpochs: 4 });
  const pos = engine.getLpPosition(a);
  assert.equal(pos.lockUntilEpoch, engine.currentEpoch + 4);
  const q = engine.quoteWithdraw({ address: a, bpsToRedeem: 100 });
  assert.equal(q.valid, false);
  assert.match(q.error, /conviction-locked until epoch 5/);

  // the page's plan mirrors the engine for the same inputs
  const plan = stakeLockPlan({ amountPoa: '50', lockEpochs: 4, epoch: engine.epochInfo(), position: { hasPosition: true, shares: '1', currentValuePoa: '100', lockUntilEpoch: engine.currentEpoch }, addressKnown: true });
  assert.equal(plan.lockUntil, pos.lockUntilEpoch);
  assert.equal(plan.relocksExisting, true);

  // lock 0 into a locked position joins the lock (engine keeps lockUntil)
  engine.applyDeposit({ txid: 't3', address: a, amountPoa: '10.000000', lockEpochs: 0 });
  assert.equal(engine.getLpPosition(a).lockUntilEpoch, 5);
  for (let i = 0; i < 4; i++) engine.advanceEpoch({ distributeIncentives: false });
  assert.equal(engine.quoteWithdraw({ address: a, bpsToRedeem: 10000 }).valid, true);
});

test('engine: epoch clock is exposed and persisted', () => {
  const engine = new BankrollEngine({ dataDir: null, initialBootstrapPoa: '1000.000000', epochLengthSeconds: 3600 });
  const s = engine.getStateSummary();
  assert.equal(s.epoch.current, 1);
  assert.equal(s.epoch.lengthSeconds, 3600);
  assert.equal(s.epoch.advancedBy, 'operator');
  assert.equal(s.epoch.withdrawWhileLocked, false);
  assert.equal(typeof s.epoch.startedAt, 'number');
  engine.advanceEpoch({ distributeIncentives: false, ts: 1800000000 });
  assert.deepEqual([engine.epochInfo().current, engine.epochInfo().startedAt], [2, 1800000000]);
  const copy = new BankrollEngine({ dataDir: null });
  copy.restoreState(engine.serializeState());
  assert.equal(copy.epochStartedAt, 1800000000);
  copy.restoreState({ ...engine.serializeState(), epochStartedAt: undefined });
  assert.equal(copy.epochStartedAt, null);
  assert.equal(new BankrollEngine({ dataDir: null }).epochLengthSeconds, 21600);
});

test('page copy: new locked stake, no existing shares', () => {
  const now = Date.UTC(2026, 9, 25, 20, 0, 0);
  const plan = stakeLockPlan({ amountPoa: '5000', lockEpochs: 4, epoch: { current: 1, lengthSeconds: 21600, startedAt: now / 1000 - 3600 }, position: null, addressKnown: true, nowMs: now });
  assert.equal(plan.lockUntil, 5);
  assert.equal(plan.unlockAtMs, now - 3600e3 + 4 * 21600e3);
  const c = stakeLockCopy(plan, { formatDate: fixedDate });
  assert.equal(c.title, 'Your POA will be locked');
  assert.equal(c.amount, 'Staking 5,000.000000 POA');
  assert.deepEqual(c.facts, [['Locked for', '4 epochs · about 24 hours'], ['Unlocks', 'Epoch 5 · about DATE'], ['Current epoch', 'Epoch 1']]);
  assert.match(flat(c), /No early exit\. Until epoch 5 the vault refuses every withdrawal and yield claim/);
  assert.match(flat(c), /From epoch 5 you can withdraw your tokens again/);
  assert.match(flat(c), /nominally 6 hours long and are advanced by the vault operator/);
  assert.doesNotMatch(flat(c), /existing/);
});

test('page copy: existing shares are re-locked, or the stake joins a longer lock', () => {
  const pos = { hasPosition: true, shares: '6031342467097769', currentValuePoa: '6010.949875', lockUntilEpoch: 1 };
  const c = stakeLockCopy(stakeLockPlan({ amountPoa: '100', lockEpochs: 2, epoch: { current: 1 }, position: pos, addressKnown: true }), { formatDate: fixedDate });
  assert.match(flat(c), /This also locks your existing 6,010\.949875 POA in the vault until epoch 3\. A lock covers your whole position/);

  const c2 = stakeLockCopy(stakeLockPlan({ amountPoa: '100', lockEpochs: 8, epoch: { current: 1 }, position: { ...pos, lockUntilEpoch: 5 }, addressKnown: true }), { formatDate: fixedDate });
  assert.match(flat(c2), /existing 6,010\.949875 POA in the vault \(currently locked until epoch 5\) until epoch 9/);

  const c3 = stakeLockCopy(stakeLockPlan({ amountPoa: '100', lockEpochs: 2, epoch: { current: 1 }, position: { ...pos, lockUntilEpoch: 5 }, addressKnown: true }), { formatDate: fixedDate });
  assert.match(flat(c3), /already locked until epoch 5, so this deposit is locked until epoch 5 too/);
  assert.equal(c3.facts[0][1], '4 epochs · about 24 hours');

  const c4 = stakeLockCopy(stakeLockPlan({ amountPoa: '100', lockEpochs: 0, epoch: { current: 1 }, position: { ...pos, lockUntilEpoch: 5 }, addressKnown: true }), { formatDate: fixedDate });
  assert.equal(c4.variant, 'lock');
  assert.equal(c4.title, 'This stake joins a locked position');

  const c5 = stakeLockCopy(stakeLockPlan({ amountPoa: '100', lockEpochs: 3, epoch: { current: 1 }, position: null, addressKnown: false }), { formatDate: fixedDate });
  assert.match(flat(c5), /If your address already holds shares in the vault, they are locked until epoch 4 too/);
});

test('page copy: lock 0 with no locked position is a lighter confirmation', () => {
  const c = stakeLockCopy(stakeLockPlan({ amountPoa: '25', lockEpochs: 0, epoch: { current: 3, earlyExitFeePercent: '0.10' }, position: null, addressKnown: true }));
  assert.equal(c.variant, 'open');
  assert.equal(c.title, 'Confirm your stake');
  assert.deepEqual(c.facts[0], ['Lock', 'None']);
  assert.match(flat(c), /0\.10% early-exit fee applies if you withdraw in the same epoch as your latest deposit \(now epoch 3\)/);
  assert.equal(formatLockDuration(60 * 3600), 'about 2.5 days (60 hours)');
});
