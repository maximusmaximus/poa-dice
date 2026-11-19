// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, signRaw } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-sec-${t}-`));

test('P1-2 & P1-4: security headers, strict CSP, 413 body limit, untrusted X-Forwarded-For refusal, and explorer inflight coalescing', async () => {
  let explorerCalls = 0;
  const targetAddr = genKeypair().address;
  const app = createDiceServer({
    dataDir: tmp('sec-hdr'),
    initialBootstrapPoa: '1000.000000',
    watcherMode: 'simulated',
    requireChain: true,
    chainSettlement: false,
    rateLimitMax: 3,
    chainCacheMs: 10000,
    chainFetch: async (address) => {
      explorerCalls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { address, balance: '100.000000', txs: [] };
    }
  });
  const info = await app.listen(0, '127.0.0.1');
  try {
    // HTML response carries strict CSP + security headers
    const htmlRes = await fetch(`${info.url}/`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(htmlRes.headers.get('x-frame-options'), 'DENY');
    assert.equal(htmlRes.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(htmlRes.headers.get('permissions-policy'));
    const csp = htmlRes.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no unsafe-inline in script-src');

    // Concurrent explorer lookups for the same address coalesce into 1 upstream fetch
    explorerCalls = 0;
    const [r1, r2, r3] = await Promise.all([
      fetch(`${info.url}/api/state?address=${targetAddr}`),
      fetch(`${info.url}/api/state?address=${targetAddr}`),
      fetch(`${info.url}/api/state?address=${targetAddr}`)
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 200);
    // At most 3 distinct addresses fetched (bank, dev, player), never 9!
    assert.ok(explorerCalls <= 3, `expected coalesced <= 3 upstream fetches, got ${explorerCalls}`);

    // 4th explorer-triggering GET from same IP hits rate limit EVEN with spoofed X-Forwarded-For headers (trustProxy=false)
    const spoofed = await fetch(`${info.url}/api/state?address=${targetAddr}`, {
      headers: { 'X-Forwarded-For': '198.51.100.99' }
    });
    assert.equal(spoofed.status, 429, 'spoofed X-Forwarded-For must not bypass per-IP rate limit');
  } finally {
    await app.close();
  }

  // Separate server for 413 oversized payload test
  const app2 = createDiceServer({ dataDir: tmp('body413'), initialBootstrapPoa: '1000.000000', watcherMode: 'simulated' });
  const info2 = await app2.listen(0, '127.0.0.1');
  try {
    const huge = JSON.stringify({ pad: 'a'.repeat(300_000) });
    const res413 = await fetch(`${info2.url}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge
    });
    assert.equal(res413.status, 413);
  } finally {
    await app2.close();
  }
});

test('P1-3 & P1-5: standby signed chat persists across reloads to leader, chain-mode auto-bet refuses cleanly, and custodial privkey kill-switch works', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const alice = genKeypair();
  mock.setBalance(bank.address, '50.000000');
  mock.setBalance(alice.address, '50.000000');
  const store = createMemoryStore(null);

  const mkNode = async (tag, extra = {}) => {
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
      rejectCheckIntervalMs: 0,
      sentGraceMs: 0,
      ledgerProbe: false,
      ...extra
    });
    const info = await app.listen(0, '127.0.0.1');
    app.settlement.client.retryBaseMs = 5;
    await app.settlement.ready();
    return { app, url: info.url, close: () => app.close() };
  };

  const leader = await mkNode('chat-leader', { disallowCustodialPrivkey: true });
  await leader.app.settlement.tick();
  await leader.app.settlement.idle();
  const standby = await mkNode('chat-standby');
  await standby.app.settlement.tick();
  await standby.app.settlement.idle();
  assert.equal(leader.app.settlement.writer.status, 'LEADER');
  assert.equal(standby.app.settlement.writer.status, 'STANDBY');

  try {
    // 1. P1-3: Signed chat posted to STANDBY persists in shared claim table and propagates to LEADER
    const msgText = 'hello from standby node';
    const sig = signRaw(msgText, alice.privRaw);
    const chatRes = await fetch(`${standby.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msgText, address: alice.address, signature: sig, senderName: 'AliceAgent' })
    });
    assert.equal(chatRes.status, 200);
    const chatBody = await chatRes.json();
    assert.equal(chatBody.ok, true);

    // Leader ticks and drains chat: claim into durable vault state
    await leader.app.settlement.tick();
    await leader.app.settlement.idle();
    assert.ok(
      leader.app.engine.chatMessages.some((m) => m.text === msgText && m.address === alice.address),
      'leader absorbed standby signed chat message'
    );

    // Standby reloads from store and still sees the message (never lost on reload!)
    await standby.app.settlement.tick();
    await standby.app.settlement.idle();
    assert.ok(
      standby.app.engine.chatMessages.some((m) => m.text === msgText && m.address === alice.address),
      'standby retains signed chat message after reload'
    );

    // 2. P1-5: Chain-mode auto-bet HTTP & MCP return clean structured refusal
    const autoHttp = await fetch(`${leader.url}/api/action/auto-bet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'flat', rolls: 3 })
    });
    assert.equal(autoHttp.status, 400);
    const autoHttpBody = await autoHttp.json();
    assert.equal(autoHttpBody.code, 'chain_mode_sequential_required');

    const autoMcpRes = await fetch(`${leader.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'dice_auto_strategy', arguments: { strategy: 'flat', rolls: 3 } }
      })
    });
    const autoMcpJson = await autoMcpRes.json();
    assert.equal(autoMcpJson.result.isError, true);
    const autoMcpData = JSON.parse(autoMcpJson.result.content[0].text);
    assert.equal(autoMcpData.code, 'chain_mode_sequential_required');

    // 3. P1-5: POA_DICE_DISALLOW_CUSTODIAL_PRIVKEY rejects privkey on HTTP + MCP
    const signSub = await fetch(`${leader.url}/api/action/sign-and-submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'BET', amountPoa: '1.000000', privkey: alice.privkey })
    });
    assert.equal(signSub.status, 400);
    assert.equal((await signSub.json()).code, 'custodial_privkey_disabled');

    const batchSub = await fetch(`${leader.url}/api/action/batch-roll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1, amount_poa: '1.000000', target_bps: 4950, direction: 'under', max_total_spend_poa: '1.000000', privkey: alice.privkey })
    });
    assert.equal(batchSub.status, 400);
    assert.equal((await batchSub.json()).code, 'custodial_privkey_disabled');

    const mcpPriv = await fetch(`${leader.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'dice_place_bet', arguments: { amount_poa: '1.000000', target_bps: 4950, direction: 'under', privkey: alice.privkey } }
      })
    });
    const mcpPrivJson = await mcpPriv.json();
    assert.equal(mcpPrivJson.result.isError, true);
    assert.match(mcpPrivJson.result.content[0].text, /Server-side privkey signing is disabled/);
  } finally {
    await standby.close();
    await leader.close();
    await mock.close();
  }
});
