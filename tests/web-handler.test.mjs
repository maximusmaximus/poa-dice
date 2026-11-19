// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebHandler } from '../src/web-handler.mjs';
import { createDiceServer } from '../src/server.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-webh-${t}-`));

test('P1-1: web-handler proxies HTTP + SSE abort cleanup, forwards authenticated client IP, and recovers from failed init', async () => {
  // 1. Failed init does not poison handler state; second call succeeds cleanly
  let attempts = 0;
  const recoverable = createWebHandler({
    serverOptions: { dataDir: tmp('recover'), initialBootstrapPoa: '1000.000000', watcherMode: 'simulated' },
    createServer: (opts) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          listen: () => Promise.reject(new Error('transient bind failure')),
          close: async () => {}
        };
      }
      return createDiceServer(opts);
    }
  });
  try {
    await assert.rejects(() => recoverable.handle(new Request('http://edge.local/api/health')), /transient bind failure/);
    const okRes = await recoverable.handle(new Request('http://edge.local/api/health'));
    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(attempts, 2);
  } finally {
    await recoverable.close();
  }

  // 2. SSE abort closes upstream loopback socket; per-IP rate limiting uses forwarded edge IP
  const handler = createWebHandler({
    serverOptions: {
      dataDir: tmp('sse-ip'),
      initialBootstrapPoa: '1000.000000',
      watcherMode: 'simulated',
      rateLimitMax: 2,
      sseKeepaliveMs: 0
    }
  });
  try {
    // Open an SSE stream and abort it
    const ctl = new AbortController();
    const sseRes = await handler.handle(new Request('http://edge.local/api/stream', { signal: ctl.signal }));
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    assert.match(new TextDecoder().decode(firstChunk.value), /stream\.connected/);

    const hBefore = await (await handler.handle(new Request('http://edge.local/api/health'))).json();
    assert.equal(hBefore.connectedSseClients, 1);

    ctl.abort();
    await reader.cancel().catch(() => {});
    // Give loopback close event a short moment to fire
    for (let i = 0; i < 20; i++) {
      const h = await (await handler.handle(new Request('http://edge.local/api/health'))).json();
      if (h.connectedSseClients === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const hAfter = await (await handler.handle(new Request('http://edge.local/api/health'))).json();
    assert.equal(hAfter.connectedSseClients, 0, 'aborted SSE client disconnected cleanly on loopback');

    // Rate limit isolation by forwarded edge IP (rateLimitMax=2 on POST)
    const postForIp = (ip) =>
      handler.handle(
        new Request('http://edge.local/api/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': ip },
          body: JSON.stringify({ serverSeed: 'abc', clientSeed: 'c', nonce: 1, betTxid: '0'.repeat(64), targetBps: 4950, direction: 'under' })
        })
      );
    assert.equal((await postForIp('203.0.113.1')).status, 200);
    assert.equal((await postForIp('203.0.113.1')).status, 200);
    assert.equal((await postForIp('203.0.113.1')).status, 429, '3rd POST from same edge IP hits rate limit');
    assert.equal((await postForIp('203.0.113.2')).status, 200, 'different edge IP gets its own bucket');
  } finally {
    await handler.close();
  }
});
