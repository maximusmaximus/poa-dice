// Live wallet balance: derivation (lagging checkpoint, outgoing, pending), HTTP route and MCP tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { genKeypair } from '../src/crypto-poa.mjs';
import { derive, makeChecker, isAddress, looksLikePrivkey, toMicros, fromMicros } from '../src/wallet-balance.mjs';
import { McpHandler } from '../src/mcp-server.mjs';

const me = genKeypair().address, them = genKeypair().address;
const id = (c) => c.repeat(64);
const row = (i, from, to, amount, final = 1, atts = 40, ts = 1000) => ({ id: i, type: 'transfer', from_addr: from, to_addr: to, amount, epoch: null, ts, atts, final });
const resp = (balance, txs) => ({ address: me, balance, balance_as_of: { checkpoint_height: 30618 }, checkpoint_height: 30618, txs });

test('lagging checkpoint: 0 at the checkpoint + final 100 in = 100 spendable', () => {
  const r = derive(me, resp('0.000000', [row(id('a'), them, me, '100.000000')]), { [id('a')]: { final: 1, atts: 40 } });
  assert.equal(r.checkpoint.balance, '0.000000');
  assert.equal(r.current, '100.000000');
  assert.equal(r.spendable, '100.000000');
});

test('outgoing after the checkpoint is subtracted; covered txs are not double counted', () => {
  const r = derive(me, resp('8943405.155398', [row(id('a'), me, them, '100.000000', 1, 40, 3), row(id('b'), me, them, '5000.000000', 1, 68, 2)]),
    { [id('a')]: { final: 1, atts: 40 }, [id('b')]: { final: 1, atts: 68, checkpointed: { height: 30618 } } });
  assert.equal(r.current, '8943305.155398');
  assert.equal(r.txs[1].inCheckpoint, true);
});

test('pending: incoming not spendable, outgoing reserved', () => {
  const r = derive(me, resp('5.000000', [row(id('a'), them, me, '30.000000', 0, 2), row(id('b'), me, them, '10.000000', 0, 1)]),
    { [id('a')]: { final: 0, atts: 2 }, [id('b')]: { final: 0, atts: 1 } });
  assert.equal(r.current, '5.000000');
  assert.equal(r.spendable, '0.000000');
  assert.equal(r.sinceCheckpoint.pendingIn, '30.000000');
  assert.equal(r.sinceCheckpoint.pendingOut, '10.000000');
  assert.equal(r.txs[0].status.state, 'pending');
});

test('validation helpers', () => {
  const kp = genKeypair();
  assert.ok(isAddress(kp.address));
  assert.ok(!isAddress('poa1xyz'));
  assert.ok(looksLikePrivkey(kp.privkey));
  assert.ok(!looksLikePrivkey(kp.address));
  assert.equal(fromMicros(toMicros('1865795757.169764')), '1865795757.169764');
});

function fakeFetch(routes) {
  return async (url, init) => {
    assert.equal(init.method, 'GET');
    const r = routes(url);
    if (r instanceof Error) throw r;
    return { status: r.status || 200, ok: (r.status || 200) < 400, json: async () => r.body };
  };
}

test('MCP wallet_balance: result, refuses a private key, busy is retryable', async () => {
  const fetch = fakeFetch(url => url.includes('/address/') ? { body: resp('0.000000', [row(id('a'), them, me, '100.000000')]) } : { body: { final: 1, atts: 40, memo: '' } });
  const checker = makeChecker({ fetch });
  const h = new McpHandler({ engine: {}, watcher: {}, hooks: { walletBalance: (a) => checker.check(a) } });
  const r = await h._callTool('wallet_balance', { address: me });
  assert.equal(r.spendable, '100.000000');
  const k = await h._callTool('wallet_balance', { address: genKeypair().privkey });
  assert.equal(k.valid, false);
  assert.match(k.error, /private key/);
  const busy = makeChecker({ fetch: fakeFetch(() => ({ status: 503, body: { error: 'origin busy — retry shortly' } })) });
  const h2 = new McpHandler({ engine: {}, watcher: {}, hooks: { walletBalance: (a) => busy.check(a) } });
  const b = await h2._callTool('wallet_balance', { address: me });
  assert.equal(b.valid, false);
  assert.equal(b.retryable, true);
});

test('HTTP GET /api/wallet/<addr>/balance: CORS, 200 result, 400 for keys and bad input, 503 while busy', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { createDiceServer } = await import('../src/server.mjs');
  let busy = false;
  const walletFetch = fakeFetch(url => {
    if (busy) return { status: 503, body: { error: 'origin busy — retry shortly', retry_after_seconds: 30 } };
    return url.includes('/address/') ? { body: resp('0.000000', [row(id('a'), them, me, '100.000000')]) } : { body: { final: 1, atts: 40, memo: '' } };
  });
  const app = createDiceServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'poa-dice-wallet-')), initialBootstrapPoa: '1000.000000', walletFetch });
  const info = await app.listen(0, '127.0.0.1');
  try {
    const ok = await fetch(`${info.url}/api/wallet/${me}/balance`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), '*');
    const j = await ok.json();
    assert.equal(j.spendable, '100.000000');
    assert.equal(j.checkpoint.balance, '0.000000');
    const key = await fetch(`${info.url}/api/wallet/${genKeypair().privkey}/balance`);
    assert.equal(key.status, 400);
    assert.match((await key.json()).error, /private key/);
    assert.equal((await fetch(`${info.url}/api/wallet/poa1nope/balance`)).status, 400);
    busy = true;
    const other = genKeypair().address; // not cached
    const b = await fetch(`${info.url}/api/wallet/${other}/balance`);
    assert.equal(b.status, 503);
    assert.equal((await b.json()).retryAfterSeconds, 30);
  } finally {
    await app.close();
  }
});
