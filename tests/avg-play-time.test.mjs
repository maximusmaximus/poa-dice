// @ts-nocheck
/**
 * Average play time: computePlayTimes (unit), /api/health + /api/state playTime (chain e2e against the
 * mock minepoa on 127.0.0.1), and the header text. Throwaway keys only; nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computePlayTimes } from '../src/play-time.mjs';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair } from '../src/crypto-poa.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const bet = (txid, submittedAt, bookedAt, won, extra = {}) => ({ txid, action: 'BET', status: 'BOOKED', submittedAt, bookedAt, result: { action: 'BET_SETTLED', won }, ...extra });
const payout = (sourceTxid, confirmedAt, extra = {}) => ({ orderId: `o-${sourceTxid}`, sourceTxid, kind: 'BET_WIN_PAYOUT', status: 'CONFIRMED', confirmedAt, ...extra });

test('computePlayTimes: loss = submitted -> booked, win = submitted -> payout confirmed', () => {
  const inbound = {
    a: bet('a', 1_000, 31_000, false), // 30 s loss
    b: bet('b', 2_000, 12_000, true), //   win, payout confirmed at 92 s -> 90 s
    c: bet('c', 5_000, 9_000, true) //     win, payout still SENT -> not counted yet
  };
  const outbound = {
    pb: payout('b', 92_000),
    pc: payout('c', null, { status: 'SENT' })
  };
  const r = computePlayTimes(inbound, outbound);
  assert.equal(r.window, 'all-time');
  assert.equal(r.plays, 2);
  assert.equal(r.losses, 1);
  assert.equal(r.wins, 1);
  assert.equal(r.avgPlaySeconds, 60);
  assert.equal(r.avgLossSeconds, 30);
  assert.equal(r.avgWinSeconds, 90);
  assert.equal(r.winsAwaitingPayout, 1);
  assert.equal(r.lastPlaySeconds, 90);
  assert.equal(r.lastPlayAt, new Date(92_000).toISOString());
});

test('computePlayTimes: leaves out non-plays and repaired timestamps', () => {
  const inbound = {
    ok: bet('ok', 1_000, 11_000, false),
    scan: bet('scan', 1_000, 5_000, false, { discoveredBy: 'ledger-scan' }), // never accepted here
    standby: bet('standby', 1_000, 21_000, false, { discoveredBy: 'ledger-scan', acceptedBy: 'standby' }), // accepted by a standby: counted
    recovered: bet('recovered', 1_000, 999_000, false, { recovered: true }),
    matched: bet('matched', 1_000, 2_000, true),
    refund: { txid: 'refund', action: 'BET', status: 'BOOKED', submittedAt: 1_000, bookedAt: 1, result: { action: 'BET_REFUNDED' } },
    open: { txid: 'open', action: 'BET', status: 'BROADCAST', submittedAt: 1_000 },
    stake: { txid: 'stake', action: 'LP_ADD', status: 'BOOKED', submittedAt: 1_000, bookedAt: 1, result: { action: 'LP_ADD' } },
    skew: bet('skew', 50_000, 40_000, false)
  };
  const outbound = { pm: payout('matched', 9_000_000, { matchedFromLedger: { via: 'ord-memo' } }) };
  const r = computePlayTimes(inbound, outbound);
  assert.equal(r.plays, 2);
  assert.equal(r.avgPlaySeconds, 15);
  assert.equal(r.excluded, 4); // scan, recovered, matched, skew
});

test('computePlayTimes: empty state => null average, zero plays', () => {
  const r = computePlayTimes({}, {});
  assert.equal(r.avgPlaySeconds, null);
  assert.equal(r.plays, 0);
});

test('header text: "Average play: N s (over M plays)"', async () => {
  globalThis.document ??= undefined;
  const { avgPlayText } = await import('../public/app.js');
  assert.equal(avgPlayText({ avgPlaySeconds: 52.4, plays: 18 }), 'Average play: 52 s (over 18 plays)');
  assert.equal(avgPlayText({ avgPlaySeconds: 4.26, plays: 1 }), 'Average play: 4.3 s (over 1 play)');
  assert.equal(avgPlayText({ avgPlaySeconds: null, plays: 0 }), 'Average play: — (no timed plays yet)');
  assert.equal(avgPlayText(null), 'Average play: — (no timed plays yet)');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(header, /id="avgPlayTime"/, 'shown at the top of the page');
  assert.doesNotMatch(html, /coming soon/i);
});

test('chain e2e: /api/health and /api/state report avgPlaySeconds after each settled play', async () => {
  const mock = await startMockMinepoa();
  const bank = genKeypair();
  const lp = genKeypair();
  const player = genKeypair();
  mock.setBalance(lp.address, '20000.000000');
  mock.setBalance(player.address, '100.000000');
  const app = createDiceServer({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'poa-dice-playtime-')),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    adminToken: 'playtime-test-admin'
  });
  const info = await app.listen(0, '127.0.0.1');
  let id = 0;
  const mcp = async (name, args = {}) => {
    const j = await fetch(`${info.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.json());
    return { isError: j.result?.isError, data: JSON.parse(j.result.content[0].text) };
  };
  const settle = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    await app.settlement.idle();
  };
  try {
    await mcp('bank_stake', { amount_poa: '10000.000000', max_total_spend_poa: '10000.000000', privkey: lp.privkey });
    mock.finalizeAll();
    await settle();
    let h = await fetch(`${info.url}/api/health`).then((r) => r.json());
    assert.equal(h.playTime.plays, 0, 'a stake is not a play');
    assert.equal(h.playTime.avgPlaySeconds, null);

    const batch = await mcp('dice_batch_roll', { count: 5, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'pt', max_total_spend_poa: '5.000000', privkey: player.privkey, wait_seconds: 0 });
    assert.equal(batch.isError, false, JSON.stringify(batch.data));
    await new Promise((r) => setTimeout(r, 60)); // measurable time in flight
    mock.finalizeAll();
    await settle();
    const statuses = batch.data.txids.map((t) => app.settlement.getTxStatus(t));
    const wins = statuses.filter((s) => s.result?.won).length;
    const losses = statuses.length - wins;
    h = await fetch(`${info.url}/api/health`).then((r) => r.json());
    assert.equal(h.playTime.losses, losses, 'losses count once booked');
    assert.equal(h.playTime.wins + h.playTime.winsAwaitingPayout, wins);

    mock.finalizeAll(); // payouts final on the ledger
    await settle();
    h = await fetch(`${info.url}/api/health`).then((r) => r.json());
    assert.equal(h.playTime.window, 'all-time');
    assert.equal(h.playTime.plays, 5);
    assert.equal(h.playTime.wins, wins);
    assert.equal(h.playTime.winsAwaitingPayout, 0);
    assert.ok(h.playTime.avgPlaySeconds >= 0.05, `avg ${h.playTime.avgPlaySeconds}`);
    const s = await fetch(`${info.url}/api/state`).then((r) => r.json());
    assert.deepEqual(s.playTime, h.playTime, '/api/state carries the same figure the page polls');
  } finally {
    await app.close();
    await mock.close();
  }
});
