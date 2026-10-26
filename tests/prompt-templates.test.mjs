// @ts-nocheck
/**
 * Generated-prompt flow (copy prompt -> agent -> MCP), self-custody:
 *  - every signed action has an exact UNSIGNED transfer template (chain id, bank address, amount,
 *    exact DICE1 memo, count) from tx_templates and in the quote's transferTemplate;
 *  - a batch built strictly from the template is accepted byte for byte;
 *  - quotes use the player's VIP tier when the address is given (quote == roll), and say the
 *    edge may be lower when it is not;
 *  - dice_batch_roll / dice_place_bet wait (bounded) for settlement and return wins, losses, net,
 *    each bet_txid with its roll, payout txids and the server seed hash, or PENDING + how to poll.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros, fromMicros } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { computeRoll } from '../src/provably-fair.mjs';
import { transferTemplates, clampWaitSeconds, MAX_WAIT_SECONDS } from '../src/tx-templates.mjs';
import { diceMemo } from '../public/app.js';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-tpl-${t}-`));
const BANK = 'poa1Cb7xuTy5QhCXvg65noJSxTebgkWwyVDTN9eqgM9h2xnd';

async function boot({ mock, bank, tag }) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    settlementStore: createMemoryStore(null),
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    mcpWaitPollMs: 20
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  let id = 0;
  const mcp = async (name, args = {}) => {
    const r = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    });
    const j = await r.json();
    if (j.error) return { isError: true, data: { error: j.error.message } };
    return { isError: j.result.isError, data: JSON.parse(j.result.content[0].text) };
  };
  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 15));
    }
    await app.settlement.idle();
  };
  return { app, url: info.url, mcp, settle, close: () => app.close() };
}

/** Build a signed transfer using ONLY the template's fields (what an outside agent would do). */
function signFromTemplate(mock, wallet, tpl) {
  return buildSignedTransfer({ wallet, to: tpl.to, amount: tpl.amount, memo: tpl.memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), cid: tpl.chainId });
}

async function stakedSetup(tag, { autoFinal = true } = {}) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal });
  const bank = genKeypair();
  const lp = genKeypair();
  const player = genKeypair();
  mock.setBalance(lp.address, '5000.000000');
  mock.setBalance(player.address, '5000.000000');
  const srv = await boot({ mock, bank, tag });
  for (const [w, amt] of [[lp, '2000.000000'], [player, '1000.000000']]) {
    mock.directSubmit(buildSignedTransfer({ wallet: w, to: bank.address, amount: amt, memo: 'DICE1:LP_ADD', nonce: mock.nextNonce(w.address), parents: mock.parents() }).body);
  }
  if (!autoFinal) mock.finalizeAll();
  await srv.settle(6);
  assert.equal(fromMicros(srv.app.engine.bankNavMicros), '3000.000000');
  mock.checkpoint();
  return { mock, bank, lp, player, srv };
}

test('templates: exact memo/to/amount/count/chain id for every signed action; page memo mirror agrees with the server', () => {
  const t = transferTemplates({ tool: 'dice_batch_roll', args: { count: 5, amount_poa: '1', target_bps: 4950, direction: 'under', client_seed: 'glass-oracle-03' }, bankAddress: BANK });
  assert.equal(t.ok, true);
  assert.equal(t.chainId, 'poa-mainnet-1');
  assert.equal(t.to, BANK);
  assert.equal(t.amount, '1.000000');
  assert.equal(t.memo, 'DICE1:BET:under:4950:glass-oracle-03');
  assert.equal(t.count, 5);
  assert.equal(t.totalPoa, '5.000000');
  assert.equal(t.signedField, 'signed_txs');
  const single = transferTemplates({ tool: 'dice_place_bet', args: { amount_poa: '2.5', target_bps: 5050, direction: 'over' }, bankAddress: BANK });
  assert.equal(single.memo, 'DICE1:BET:over:5050:mcp-agent', 'defaults to the seed dice_place_bet would use');
  assert.equal(single.signedField, 'signed_tx');
  assert.equal(transferTemplates({ tool: 'bank_stake', args: { amount_poa: '1000', lock_epochs: 3, referrer: BANK }, bankAddress: BANK }).memo, `DICE1:LP_ADD:epochs=3:ref=${BANK}`);
  const wAll = transferTemplates({ tool: 'bank_withdraw', args: { mode: 'ALL' }, bankAddress: BANK });
  assert.deepEqual([wAll.amount, wAll.memo], ['0.000001', 'DICE1:LP_WITHDRAW:ALL']);
  assert.equal(transferTemplates({ tool: 'bank_withdraw', args: { mode: 'BPS', bps: 2500 }, bankAddress: BANK }).memo, 'DICE1:LP_WITHDRAW:BPS=2500');
  assert.equal(transferTemplates({ tool: 'bank_withdraw', args: { mode: 'SHARES', shares: '123' }, bankAddress: BANK }).memo, 'DICE1:LP_WITHDRAW:123');
  assert.equal(transferTemplates({ tool: 'bank_claim_yield', args: {}, bankAddress: BANK }).ok, false, 'claim needs the dry run shares');
  assert.equal(transferTemplates({ tool: 'bank_claim_yield', args: {}, bankAddress: BANK, claimShares: '42' }).memo, 'DICE1:LP_WITHDRAW:42');
  assert.equal(transferTemplates({ tool: 'dice_auto_strategy', args: { base_wager_poa: '1', target_bps: 4950, direction: 'under' }, bankAddress: BANK }).signedField, 'privkey');
  const chat = transferTemplates({ tool: 'chat_send', args: { text: 'gm' }, bankAddress: null });
  assert.deepEqual([chat.kind, chat.signedField, chat.transfers.length], ['signature', 'signature', 0]);
  assert.equal(transferTemplates({ tool: 'dice_batch_roll', args: { count: 3, amount_poa: '1', target_bps: 4950, direction: 'under' }, bankAddress: BANK }).ok, false);
  assert.equal(transferTemplates({ tool: 'dice_batch_roll', args: { count: 1, amount_poa: '1', target_bps: 4950, direction: 'under', client_seed: 'bad seed!' }, bankAddress: BANK }).ok, false);
  assert.equal(transferTemplates({ tool: 'bank_stake', args: { amount_poa: '10' }, bankAddress: null }).ok, false, 'bank offline: no template');
  assert.equal(transferTemplates({ tool: 'dice_batch_roll', args: { count: 1, amount_poa: '1', target_bps: 4950, direction: 'under' }, bankAddress: BANK, chainId: 'poa-testnet-9' }).chainId, 'poa-testnet-9');
  for (const spec of [
    { action: 'BET', direction: 'under', targetBps: 4950, clientSeed: 'glass-oracle-03' },
    { action: 'BET', direction: 'over', targetBps: 199, clientSeed: 'a.b-c_d' },
    { action: 'LP_ADD', lockEpochs: 0 },
    { action: 'LP_ADD', lockEpochs: 7, referrer: BANK },
    { action: 'LP_WITHDRAW', bps: 10000 },
    { action: 'LP_WITHDRAW', bps: 5000 },
    { action: 'LP_WITHDRAW', shares: '9876543210' }
  ]) assert.equal(diceMemo(spec), formatDiceMemo(spec), JSON.stringify(spec));
  assert.equal(clampWaitSeconds(undefined), 60);
  assert.equal(clampWaitSeconds(0), 0);
  assert.equal(clampWaitSeconds(999), MAX_WAIT_SECONDS);
  assert.equal(clampWaitSeconds(-5), 0);
});

test('quotes carry the template and use the VIP tier of the given address; without an address they say the edge may be lower', async () => {
  const { mock, bank, player, srv } = await stakedSetup('quote');
  try {
    const args = { count: 1, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'glass-oracle-03', max_total_spend_poa: '1.000000' };
    const anon = (await srv.mcp('dice_quote_batch', args)).data;
    assert.equal(anon.valid, true, JSON.stringify(anon));
    assert.equal(anon.houseEdgePercent, '1.00');
    assert.equal(anon.addressUsed, null);
    assert.match(anon.vipNote, /VIP/);
    const vip = (await srv.mcp('dice_quote_batch', { ...args, address: player.address })).data;
    assert.equal(vip.houseEdgePercent, '0.90', 'Bronze staker edge');
    assert.equal(vip.vipNote, null);
    assert.equal(vip.addressUsed, player.address);
    assert.deepEqual(
      { to: vip.transferTemplate.to, amount: vip.transferTemplate.amount, memo: vip.transferTemplate.memo, count: vip.transferTemplate.count, chainId: vip.transferTemplate.chainId },
      { to: bank.address, amount: '1.000000', memo: 'DICE1:BET:under:4950:glass-oracle-03', count: 1, chainId: 'poa-mainnet-1' }
    );
    const viaTool = (await srv.mcp('tx_templates', { tool: 'dice_batch_roll', ...args })).data;
    assert.equal(viaTool.memo, vip.transferTemplate.memo);
    const single = (await srv.mcp('dice_quote_bet', { amount_poa: '1.000000', target_bps: 4950, direction: 'under' })).data;
    assert.match(single.vipNote, /VIP/);
    assert.equal(single.transferTemplate.memo, 'DICE1:BET:under:4950:mcp-agent');
    const dep = (await srv.mcp('bank_quote_deposit', { amount_poa: '100', lock_epochs: 2, address: player.address })).data;
    assert.equal(dep.transferTemplate.memo, 'DICE1:LP_ADD:epochs=2');
    assert.equal(dep.transferTemplate.amount, '100.000000');
    const wq = (await srv.mcp('bank_quote_withdraw', { address: player.address, mode: 'BPS', bps: 5000 })).data;
    assert.equal(wq.transferTemplate.memo, 'DICE1:LP_WITHDRAW:BPS=5000');
    // REST quotes used by the page carry the same template
    const rest = await (await fetch(`${srv.url}/api/quote/batch?amountPoa=1.000000&targetBps=4950&direction=under&clientSeed=glass-oracle-03&address=${player.address}`)).json();
    const c1 = rest.counts.find((c) => c.count === 1);
    assert.equal(c1.transferTemplate.memo, 'DICE1:BET:under:4950:glass-oracle-03');
    assert.equal(c1.houseEdgePercent, '0.90');
    const acts = await (await fetch(`${srv.url}/api/quote/actions?address=${player.address}&depositPoa=50&lockEpochs=0&withdrawBps=10000&amountPoa=1&targetBps=4950&direction=under`)).json();
    assert.equal(acts.stake.transferTemplate.memo, 'DICE1:LP_ADD');
    assert.equal(acts.withdraw.transferTemplate.memo, 'DICE1:LP_WITHDRAW:ALL');
    assert.equal(acts.withdraw.transferTemplate.amount, '0.000001');
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    const st = await (await fetch(`${srv.url}/api/state`)).json();
    assert.equal(st.chainId, health.chainId);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('wait mode: a batch signed strictly from the template settles inside wait_seconds and reports wins/losses/net/rolls/payouts/seed hash; quote == roll for a VIP', async () => {
  const { mock, bank, player, srv } = await stakedSetup('wait');
  try {
    const args = { count: 5, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'glass-oracle-03', max_total_spend_poa: '5.000000' };
    const q = (await srv.mcp('dice_quote_batch', { ...args, address: player.address })).data;
    assert.equal(q.valid, true, JSON.stringify(q));
    const tpl = q.transferTemplate;
    const signed = Array.from({ length: tpl.count }, () => signFromTemplate(mock, player, tpl));
    const r = await srv.mcp('dice_batch_roll', { ...args, signed_txs: signed, wait_seconds: 30 });
    assert.equal(r.isError, false, JSON.stringify(r.data).slice(0, 500));
    const d = r.data;
    assert.equal(d.signer, 'signed_txs');
    assert.equal(d.waitStatus, 'COMPLETE', JSON.stringify(d).slice(0, 800));
    assert.equal(d.status, 'SETTLED');
    assert.equal(d.wins + d.losses, 5);
    assert.equal(d.rolls.length, 5);
    assert.equal(d.next, null);
    assert.equal(d.serverSeedHash, srv.app.engine.seedManager.currentSeedHash);
    let net = 0n;
    const seed = srv.app.engine.seedManager.currentSeed;
    const outs = mock.transfersFrom(bank.address);
    for (const roll of d.rolls) {
      assert.match(roll.betTxid, /^[0-9a-f]{64}$/);
      const again = computeRoll({ serverSeed: seed, clientSeed: roll.verify.clientSeed, nonce: roll.verify.nonce, betTxid: roll.betTxid });
      assert.equal(again.rollDisplay, roll.rollDisplay, 'HMAC gives the stated roll');
      assert.equal(again.hmacHex, roll.verify.hmacHex);
      assert.equal(roll.won, again.rollBps < 4950);
      if (roll.won) {
        assert.equal(roll.payoutPoa, q.payoutOnWinPoa, 'VIP quote payout == actual payout');
        assert.equal(roll.payoutStatus, 'CONFIRMED');
        const p = outs.filter((o) => o.body.memo.startsWith(`DICE1:WIN:${roll.betTxid.slice(0, 16)}:`));
        assert.equal(p.length, 1, 'exactly one payout');
        assert.match(p[0].body.memo, new RegExp(`:roll=${roll.rollDisplay.replace('.', '\\.')}:`), 'payout memo roll == stored roll');
        net += toMicros(roll.payoutPoa) - toMicros('1');
      } else {
        assert.equal(roll.payoutTxid, null);
        net -= toMicros('1');
      }
    }
    assert.equal(toMicros(d.netPoa.replace('-', '')) * (d.netPoa.startsWith('-') ? -1n : 1n), net);
    // a tampered memo (not from the template) is refused before broadcast
    const bad = buildSignedTransfer({ wallet: player, to: tpl.to, amount: tpl.amount, memo: 'DICE1:BET:under:4950:other', nonce: mock.nextNonce(player.address), parents: mock.parents() });
    const rej = await srv.mcp('dice_batch_roll', { ...args, count: 1, max_total_spend_poa: '1.000000', signed_txs: [bad], wait_seconds: 0 });
    assert.equal(rej.isError, true);
    assert.match(JSON.stringify(rej.data), /memo must be exactly DICE1:BET:under:4950:glass-oracle-03/);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('wait mode: dice_place_bet returns the settled roll; when time runs out it returns PENDING with tx_status instructions; wait_seconds is capped', async () => {
  const { mock, bank, player, srv } = await stakedSetup('pending', { autoFinal: false });
  try {
    const tpl = (await srv.mcp('tx_templates', { tool: 'dice_place_bet', amount_poa: '1.000000', target_bps: 9500, direction: 'under', client_seed: 'single-1' })).data;
    assert.equal(tpl.ok, true);
    // ledger never finalizes within 1 s -> pending + how to poll
    const r = (await srv.mcp('dice_place_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under', signed_tx: signFromTemplate(mock, player, tpl), wait_seconds: 1 })).data;
    assert.equal(r.status, 'PENDING_CONFIRMATION', JSON.stringify(r).slice(0, 600));
    assert.equal(r.waitStatus, 'PENDING');
    assert.equal(r.pending, 1);
    assert.match(r.next, /tx_status/);
    assert.match(r.next, /Do not resend/);
    // finalize, then a second bet with a capped wait settles completely
    mock.finalizeAll();
    await srv.settle(4);
    const before = Date.now();
    const finalizer = setInterval(() => mock.finalizeAll(), 30);
    let r2;
    try {
      r2 = (await srv.mcp('dice_place_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under', signed_tx: signFromTemplate(mock, player, { ...tpl, memo: 'DICE1:BET:under:9500:single-2' }), wait_seconds: 999 })).data;
    } finally {
      clearInterval(finalizer);
    }
    assert.equal(r2.waitSeconds, 120, 'capped at 120');
    assert.ok(Date.now() - before < 60000);
    assert.equal(r2.waitStatus, 'COMPLETE', JSON.stringify(r2).slice(0, 800));
    assert.equal(r2.rawStatus, 'BOOKED');
    assert.equal(r2.rolls.length, 1);
    assert.ok(r2.rolls[0].rollDisplay);
    if (r2.rolls[0].won) assert.match(r2.rolls[0].payoutTxid, /^[0-9a-f]{64}$/);
    assert.equal(r2.serverSeedHash, srv.app.engine.seedManager.currentSeedHash);
    const paysFor = (txid) => mock.transfersFrom(bank.address).filter((o) => o.body.memo.includes(`:${txid.slice(0, 16)}:`)).length;
    assert.equal(paysFor(r2.rolls[0].betTxid), r2.rolls[0].won ? 1 : 0, 'exactly one payout on a win, none on a loss');
    assert.ok(paysFor(r.txid) <= 1, 'the earlier pending bet is never paid twice');
    // wait_seconds: 0 keeps the old broadcast-only reply
    const r3 = (await srv.mcp('dice_place_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under', signed_tx: signFromTemplate(mock, player, { ...tpl, memo: 'DICE1:BET:under:9500:single-3' }), wait_seconds: 0 })).data;
    assert.equal(r3.status, 'PENDING_CONFIRMATION');
    assert.equal(r3.waitStatus, undefined);
  } finally {
    await srv.close();
    await mock.close();
  }
});
