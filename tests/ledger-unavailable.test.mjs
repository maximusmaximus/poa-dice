// @ts-nocheck
/**
 * LEDGER_UNAVAILABLE: when minepoa can't accept transactions (/api/txs or /api/submit answer
 * 401/403/5xx, time out, or a real payout broadcast fails that way) trading pauses by itself:
 * quotes are invalid with the reason, bets / stakes / withdrawals are refused BEFORE broadcast,
 * queued payouts keep retrying with the same signed body (never paid twice), and trading
 * resumes after consecutive healthy probes (hysteresis). Runs against the local mock node only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerProbe, LEDGER_HOLD, LEDGER_HOLD_REASON, isLedgerOutage } from '../src/ledger-probe.mjs';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair } from '../src/crypto-poa.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-ledger-${t}-`));

function fakeNode() {
  const st = { txs: 200, submit: 400, submitJson: true, hang: false, calls: [] };
  const fetchImpl = async (url, init = {}) => {
    st.calls.push({ url, method: init.method || 'GET', body: init.body });
    if (st.hang) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const json = (status, obj) => ({ status, ok: status < 400, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
    if (url.endsWith('/api/txs')) return st.txs === 200 ? json(200, { valid: [{ id: 'a' }, { id: 'b' }] }) : json(st.txs, 'error code: 1101');
    if (url.includes('/api/submit')) return st.submitJson ? json(st.submit, { error: st.submit === 400 ? 'bad tx type' : 'Unauthorized' }) : json(st.submit, '<html>');
    return json(404, {});
  };
  return { st, fetchImpl };
}

test('probe: what it sends is harmless (dry run, empty unsigned body) and what counts as healthy', async () => {
  const { st, fetchImpl } = fakeNode();
  const p = new LedgerProbe({ nodeUrl: 'https://node', fetchImpl });
  assert.equal(await p.probe(), null);
  const sub = st.calls.find((c) => c.url.includes('/api/submit'));
  assert.equal(sub.url, 'https://node/api/submit?dry=1');
  assert.deepEqual(JSON.parse(sub.body), { kind: 'tx', body: {} });
  assert.deepEqual([p.lastChecks.txs.ok, p.lastChecks.submit.ok], [true, true]);
  for (const [k, v, expectOk] of [['submit', 401, false], ['submit', 403, false], ['submit', 500, false], ['submit', 429, false], ['submit', 422, true], ['txs', 500, false], ['txs', 401, false]]) {
    st.txs = 200; st.submit = 400;
    st[k] = v;
    await p.probe();
    const c = p.lastChecks[k];
    assert.equal(c.ok, expectOk, `${k} ${v}`);
  }
  st.txs = 200; st.submit = 502; st.submitJson = false;
  await p.probe();
  assert.equal(p.lastChecks.submit.ok, false, 'non-JSON gateway page is unhealthy');
  st.hang = true;
  await p.probe();
  assert.match(p.lastChecks.txs.detail, /timeout/);
  assert.equal(isLedgerOutage({ status: 401 }), true);
  assert.equal(isLedgerOutage({ status: 400 }), false, 'a definitive rejection of one tx is not an outage');
  assert.equal(isLedgerOutage(new Error('minepoa /api/txs -> HTTP 500')), true);
});

test('probe state machine: 2 fails to pause, real failure pauses at once, 2 oks + min hold to resume', async () => {
  const { st, fetchImpl } = fakeNode();
  let t = 1_000_000;
  const changes = [];
  const p = new LedgerProbe({ fetchImpl, now: () => t, intervalMs: 20000, minHoldMs: 30000, onChange: (v) => changes.push(v.status) });
  st.submit = 401;
  await p.probe();
  assert.equal(p.hold(), null, 'one failed probe does not pause (no flapping)');
  t += 20000;
  await p.probe();
  assert.deepEqual(p.hold(), { status: LEDGER_HOLD, reason: LEDGER_HOLD_REASON, since: t, lastError: p.lastError });
  assert.match(p.lastError, /\/api\/submit HTTP 401/);
  assert.equal(p.view().nextProbeAt, new Date(t + 20000).toISOString());
  st.submit = 400;
  t += 10000;
  await p.probe();
  t += 10000;
  await p.probe();
  assert.ok(p.hold(), '2 healthy probes but only 20 s in the hold: still paused');
  t += 10000;
  await p.probe();
  assert.equal(p.hold(), null, 'resumed');
  st.submit = 401;
  t += 1000;
  await p.probe();
  st.submit = 400;
  t += 1000;
  await p.probe();
  assert.equal(p.hold(), null, 'a single blip between healthy probes does not pause');
  assert.equal(p.reportFailure('payout broadcast', { status: 400, message: 'stale parents' }), false);
  assert.equal(p.hold(), null);
  p.reportFailure('payout broadcast', Object.assign(new Error('minepoa submit rejected: Unauthorized'), { status: 401 }));
  assert.ok(p.hold(), 'a real 401 on a payout pauses at once');
  assert.deepEqual(changes, ['UNAVAILABLE', 'OK', 'UNAVAILABLE']);
  // cached: maybeProbe does not call the node again inside the interval
  const n = st.calls.length;
  t += 20000;
  await p.maybeProbe();
  assert.equal(st.calls.length, n + 2, 'first maybeProbe after a report probes (last probe older than interval)');
  await p.maybeProbe();
  assert.equal(st.calls.length, n + 2, 'second one inside the interval is cached');
});

async function boot(mock, bank, tag) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey },
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    ledgerProbeIntervalMs: 0,
    ledgerProbeMinHoldMs: 0
  });
  const info = await app.listen(0, '127.0.0.1');
  let id = 0;
  const mcp = async (name, args = {}) => {
    const r = await fetch(`${info.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json();
    return { isError: j.result.isError, data: JSON.parse(j.result.content[0].text) };
  };
  const settle = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    await app.settlement.idle();
  };
  const get = async (p) => (await fetch(info.url + p)).json();
  return { app, url: info.url, mcp, settle, get, close: () => app.close() };
}

test('server: outage pauses quotes, bets, stakes and withdrawals before broadcast; health/SSE show it; auto-resume', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  const player = genKeypair();
  mock.setBalance(lp.address, '20000.000000');
  mock.setBalance(player.address, '100.000000');
  const srv = await boot(mock, bank, 'pause');
  try {
    await srv.mcp('bank_stake', { amount_poa: '10000.000000', max_total_spend_poa: '10000.000000', privkey: lp.privkey });
    await srv.settle();
    assert.equal((await srv.get('/api/health')).settlement.trading, 'OPEN');
    assert.equal((await srv.mcp('dice_quote_bet', { amount_poa: '1.000000', target_bps: 4950, direction: 'under', address: player.address })).data.valid, true);

    const events = [];
    srv.app.engine.onEvent((e) => events.push(e));
    mock.setOutage(401);
    await srv.app.settlement.ledgerProbe.probe();
    await srv.app.settlement.ledgerProbe.probe();
    const h = await srv.get('/api/health');
    assert.equal(h.settlement.trading, 'PAUSED_LEDGER_UNAVAILABLE');
    assert.equal(h.settlement.ledger.status, 'UNAVAILABLE');
    assert.ok(h.settlement.ledger.since && h.settlement.ledger.nextProbeAt);
    assert.match(h.settlement.ledger.lastError, /401/);
    assert.ok(events.some((e) => e.type === 'ledger.status' && e.payload?.status === 'UNAVAILABLE'), 'SSE event');

    const submitsBefore = mock.submits.length;
    const q = (await srv.mcp('dice_quote_bet', { amount_poa: '1.000000', target_bps: 4950, direction: 'under', address: player.address })).data;
    assert.equal(q.valid, false);
    assert.equal(q.code, LEDGER_HOLD);
    assert.equal(q.reason, LEDGER_HOLD_REASON);
    const batchQ = await srv.get(`/api/quote/batch?amountPoa=1&targetBps=4950&direction=under&clientSeed=x&address=${player.address}`);
    assert.ok(batchQ.counts.every((c) => c.valid === false && c.code === LEDGER_HOLD));
    const bet = await srv.mcp('dice_place_bet', { amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'p', privkey: player.privkey, wait_seconds: 0 });
    assert.equal(bet.data.valid, false);
    assert.equal(bet.data.code, LEDGER_HOLD);
    const batch = await srv.mcp('dice_batch_roll', { count: 5, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'b', max_total_spend_poa: '5.000000', privkey: player.privkey, wait_seconds: 0 });
    assert.equal(batch.data.valid, false);
    const stake = await srv.mcp('bank_stake', { amount_poa: '5.000000', max_total_spend_poa: '5.000000', privkey: player.privkey });
    assert.equal(stake.data.code, LEDGER_HOLD);
    assert.equal((await srv.mcp('bank_quote_deposit', { amount_poa: '5.000000', lock_epochs: 0 })).data.code, LEDGER_HOLD);
    const actions = await srv.get(`/api/quote/actions?address=${lp.address}&depositPoa=5&lockEpochs=0`);
    for (const k of ['stake', 'withdraw', 'claim']) assert.equal(actions[k].valid, false, k);
    assert.equal(actions.stake.code, LEDGER_HOLD);
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: lp.privkey });
    assert.equal(wd.data.code, LEDGER_HOLD);
    // a raw signed submit is refused before broadcast too
    assert.equal(mock.submits.length, submitsBefore, 'nothing was broadcast while paused');
    assert.equal(srv.app.engine.totalBetsCount, 0);

    mock.setOutage(0);
    await srv.app.settlement.ledgerProbe.probe();
    assert.equal((await srv.get('/api/health')).settlement.trading, 'PAUSED_LEDGER_UNAVAILABLE', 'one healthy probe is not enough');
    await srv.app.settlement.ledgerProbe.probe();
    assert.equal((await srv.get('/api/health')).settlement.trading, 'OPEN', 'resumes after 2 healthy probes');
    assert.ok(events.some((e) => e.type === 'ledger.status' && e.payload?.status === 'OK' && e.payload.resumedAt));
    const ok = await srv.mcp('dice_place_bet', { amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'after', privkey: player.privkey, wait_seconds: 0 });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('payout during an outage stays queued, retries after recovery with the same body, paid exactly once', async () => {
  for (const [status, paths] of [[401, ['/api/submit']], [503, ['/api/txs', '/api/submit']]]) {
    const mock = await startMockMinepoa({ autoFinal: true });
    const bank = genKeypair();
    const player = genKeypair();
    mock.setBalance(player.address, '100.000000');
    const srv = await boot(mock, bank, `payout-${status}`);
    try {
      await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: player.privkey });
      await srv.settle();
      const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
      assert.equal(wd.isError, false, JSON.stringify(wd.data));
      mock.setOutage(status, paths); // the trigger is on chain; the payout broadcast now fails
      for (let i = 0; i < 8; i++) await srv.settle(1);
      let out = srv.app.settlement.getTxStatus(wd.data.txid).payouts[0];
      assert.notEqual(out.status, 'CONFIRMED');
      assert.notEqual(out.status, 'FAILED', `${status}: an outage never fails the payout`);
      assert.equal(out.superseded.length, 0, `${status}: never re-signed on an outage`);
      assert.equal(mock.transfersFrom(bank.address).length, 0);
      const hh = (await srv.get('/api/health')).settlement;
      // (the books may also be in SOLVENCY_HOLD here: the whole bank is being withdrawn; that hold takes precedence)
      assert.equal(hh.ledger.status, 'UNAVAILABLE', `${status}: a failed payout broadcast pauses trading`);
      assert.notEqual(hh.trading, 'OPEN');
      mock.setOutage(0);
      for (let i = 0; i < 10; i++) await srv.settle(1);
      out = srv.app.settlement.getTxStatus(wd.data.txid).payouts[0];
      assert.equal(out.status, 'CONFIRMED', JSON.stringify(out));
      assert.equal(mock.transfersFrom(bank.address).length, 1, `${status}: exactly one payout`);
      assert.equal((await srv.get('/api/health')).settlement.ledger.status, 'OK', 'ledger hold cleared after recovery');
    } finally {
      await srv.close();
      await mock.close();
    }
  }
});

test('client.getTx: only an explicit "unknown" means never seen; a re-deriving read node is unknown (throws)', async () => {
  const { MinepoaClient } = await import('../src/minepoa-client.mjs');
  const mk = (body) => new MinepoaClient({ nodeUrl: 'https://n', fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }), retries: 1 });
  await assert.rejects(mk({ error: 'not in segments' }).getTx('ab'), /cannot answer/);
  assert.equal(await mk({ error: 'unknown txid — not seen by this node' }).getTx('ab'), null);
});
