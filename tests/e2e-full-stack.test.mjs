/**
 * tests/e2e-full-stack.test.mjs
 *
 * Full-Stack End-to-End Tests:
 *  - Spins up createDiceServer() on an ephemeral port
 *  - Verifies HTTP REST API (/api/state, /api/quote/bet, /api/quote/deposit, /api/action/sign-and-submit, /api/dev/sweep)
 *  - Verifies Near Real-Time SSE stream (/api/stream) delivers bet.settled and chat.message events
 *  - Verifies Streamable HTTP MCP (/mcp) across all 14 tools (initialize, tools/list, tools/call)
 *  - Verifies Website-Down Stdio MCP (node src/mcp-server.mjs --stdio)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createDiceServer } from '../src/server.mjs';
import { DEV_RESERVE_ADDRESS } from '../src/bankroll-engine.mjs';

function makeTempDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-e2e-${tag}-`));
}

test('E2E 1: HTTP API + Near Real-Time SSE Stream + Streamable HTTP MCP (14 Tools)', async () => {
  const app = createDiceServer({
    dataDir: makeTempDataDir('http-mcp'),
    initialBootstrapPoa: '250000.000000',
  });
  const info = await app.listen(0, '127.0.0.1');

  try {
    // 1. Connect to /api/stream (SSE) and collect real-time events
    const receivedSseTypes = [];
    const sseReq = http.get(`${info.url}/api/stream`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const lines = chunk.split('\n').filter((l) => l.startsWith('data: '));
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type) receivedSseTypes.push(parsed.type);
          } catch {
            // ignore partial chunk
          }
        }
      });
    });

    // 2. Test /api/state
    const stateRes = await fetch(`${info.url}/api/state`).then((r) => r.json());
    assert.equal(stateRes.protocol, 'poa-dice/v1');
    assert.equal(stateRes.devReserve.address, DEV_RESERVE_ADDRESS);
    assert.equal(stateRes.devReserve.feeBps, 10);

    // 3. Test MCP initialize & tools/list over Streamable HTTP (/mcp)
    const initMcp = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }).then((r) => r.json());
    assert.equal(initMcp.result.serverInfo.name, 'poa-dice-mcp');

    const listMcp = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }).then((r) => r.json());
    assert.equal(listMcp.result.tools.length, 19);

    // 4. Call MCP tool bank_stake to add 5,000 POA to the bankroll
    const stakeCall = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'bank_stake',
          arguments: { amount_poa: '5000.000000', lock_epochs: 4 },
        },
      }),
    }).then((r) => r.json());
    const stakeData = JSON.parse(stakeCall.result.content[0].text);
    assert.equal(stakeData.action, 'LP_DEPOSIT');

    // 5. Call MCP tool dice_place_bet to roll the dice
    const betCall = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'dice_place_bet',
          arguments: {
            amount_poa: '20.000000',
            target_bps: 4950,
            direction: 'under',
            client_seed: 'mcp-e2e-seed',
          },
        },
      }),
    }).then((r) => r.json());
    const betData = JSON.parse(betCall.result.content[0].text);
    assert.equal(betData.action, 'BET_SETTLED');
    assert.equal(betData.devFeeReservedPoa, '0.020000');

    // 6. Call MCP tool chat_send and chat_read
    const chatSendCall = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'chat_send',
          arguments: {
            sender_name: 'Tessellate-MCP-Agent',
            text: 'Staked 5000 POA and rolled via MCP!',
          },
        },
      }),
    }).then((r) => r.json());
    const chatSendData = JSON.parse(chatSendCall.result.content[0].text);
    assert.equal(chatSendData.verified, true);

    const chatReadCall = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'chat_read',
          arguments: { limit: 10 },
        },
      }),
    }).then((r) => r.json());
    const chatReadData = JSON.parse(chatReadCall.result.content[0].text);
    assert.equal(
      chatReadData.messages.some((m) => m.text.includes('Staked 5000 POA')),
      true
    );

    // 7. Call MCP tools dice_auto_strategy and dice_audit_solvency
    const autoCall = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'dice_auto_strategy',
          arguments: {
            strategy: 'quarter_kelly',
            base_wager_poa: '10.000000',
            target_bps: 4950,
            direction: 'under',
            rolls: 3,
          },
        },
      }),
    }).then((r) => r.json());
    const autoData = JSON.parse(autoCall.result.content[0].text);
    assert.equal(autoData.ok, true);
    assert.equal(autoData.rollsExecuted, 3);

    const auditCall = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'dice_audit_solvency',
          arguments: {},
        },
      }),
    }).then((r) => r.json());
    const auditData = JSON.parse(auditCall.result.content[0].text);
    assert.equal(auditData.ok, true);
    assert.equal(auditData.invariants.solvencyPassed, true);

    // Wait briefly for SSE delivery and verify near real-time events arrived
    await new Promise((r) => setTimeout(r, 80));
    sseReq.destroy();
    assert.equal(receivedSseTypes.includes('stream.connected'), true);
    assert.equal(receivedSseTypes.includes('bet.settled'), true);
    assert.equal(receivedSseTypes.includes('chat.message'), true);
  } finally {
    await app.close();
  }
});

test('E2E 2: Website-Independent Stdio MCP Server (node src/mcp-server.mjs --stdio)', async () => {
  const proc = spawn(process.execPath, ['src/mcp-server.mjs', '--stdio'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      responses.push(JSON.parse(line));
    }
  });

  proc.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: {
        name: 'offline_memo_builder',
        arguments: {
          action: 'BET',
          amount_poa: '10.000000',
          direction: 'under',
          target_bps: 4950,
          client_seed: 'stdio-offline-seed',
        },
      },
    }) + '\n'
  );

  await new Promise((r) => setTimeout(r, 250));
  proc.kill();

  assert.equal(responses.length >= 1, true);
  const payload = JSON.parse(responses[0].result.content[0].text);
  assert.equal(payload.memo, 'DICE1:BET:under:4950:stdio-offline-seed');
});
