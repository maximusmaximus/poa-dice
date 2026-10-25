#!/usr/bin/env node
/**
 * server.mjs — POA Dice HTTP API, Near Real-Time SSE Stream (/api/stream),
 * Streamable HTTP MCP Endpoint (/mcp) & Responsive Static Web UI Server.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSignedTransfer,
  formatDiceMemo,
  fromMicros,
  genKeypair,
  isValidPoaAddress,
  redactSecrets,
  signRaw,
  toMicros,
  verifyRaw,
  walletFromPrivkey
} from './crypto-poa.mjs';
import { verifyRoll } from './provably-fair.mjs';
import { BankrollEngine, DEV_RESERVE_ADDRESS } from './bankroll-engine.mjs';
import { LedgerWatcher } from './ledger-watcher.mjs';
import { MCP_TOOLS, McpHandler } from './mcp-server.mjs';
import {
  fetchExplorerAddress,
  formatMicros,
  loadDebits,
  rememberDebit,
  saveDebits,
  spendableMicros
} from './chain-feed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

export function createDiceServer(options = {}) {
  const dataDir = options.dataDir !== undefined ? options.dataDir : path.resolve(__dirname, '..', 'data');
  const engine =
    options.engine ||
    new BankrollEngine({
      dataDir,
      initialBootstrapPoa:
        options.initialBootstrapPoa !== undefined
          ? options.initialBootstrapPoa
          : process.env.POA_DICE_BOOTSTRAP_POA || null,
      bootstrapAddress: DEV_RESERVE_ADDRESS
    });

  const watcher =
    options.watcher ||
    new LedgerWatcher({
      engine,
      mode: options.watcherMode || 'simulated'
    });

  const mcpHandler = new McpHandler({ engine, watcher });
  const sseClients = new Set();
  const requireChain = watcher.mode !== 'simulated';
  const chainCache = new Map();
  let chainDebits = dataDir ? loadDebits(dataDir) : [];

  async function cachedExplorer(address) {
    const hit = chainCache.get(address);
    if (hit && Date.now() - hit.at < 15000) return hit.row;
    const row = await fetchExplorerAddress(watcher.nodeUrl, address);
    chainCache.set(address, { at: Date.now(), row });
    return row;
  }

  async function assertChainSpendable(address, amountPoa) {
    if (!requireChain) return;
    let row;
    try {
      row = await cachedExplorer(address);
    } catch (err) {
      const error = new Error('minepoa.com balance is unavailable. This action was not booked.');
      error.status = 503;
      throw error;
    }
    const have = spendableMicros(row.balance, chainDebits, address);
    const need = toMicros(amountPoa);
    if (have < need) {
      const error = new Error(
        `On-chain spendable balance is ${formatMicros(have)} POA. This signer does not hold ${amountPoa} POA, so nothing was booked.`
      );
      error.status = 400;
      throw error;
    }
  }

  function noteChainDebit(address, txid, amountPoa) {
    if (!requireChain || !txid) return;
    chainDebits = rememberDebit(chainDebits, {
      txid,
      address,
      amountMicros: toMicros(amountPoa).toString()
    });
    if (dataDir) saveDebits(dataDir, chainDebits);
  }

  // Broadcast every engine event over SSE in near real-time (<10ms)
  engine.onEvent((evt) => {
    const frame = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
    const genericFrame = `data: ${JSON.stringify(evt)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
        client.write(genericFrame);
      } catch {
        sseClients.delete(client);
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        });
        res.end();
        return;
      }

      const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      // 1. Health endpoint
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          protocol: 'poa-dice/v1',
          chainId: 'poa-mainnet-1',
          bankAddress: engine.bankAddress,
          devReserveAddress: DEV_RESERVE_ADDRESS,
          devFeeBps: 10,
          stateRootSha256: engine.computeStateRoot(),
          connectedSseClients: sseClients.size,
          mcpEndpoint: '/mcp'
        });
      }

      // 2. Near Real-Time SSE Stream
      if (pathname === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        res.write(
          `data: ${JSON.stringify({
            type: 'stream.connected',
            ts: Math.floor(Date.now() / 1000),
            payload: {
              stateRootSha256: engine.computeStateRoot(),
              bankNavPoa: engine.getStateSummary().bankroll.bankNavPoa,
              devReserveAddress: DEV_RESERVE_ADDRESS
            }
          })}\n\n`
        );
        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // 3. Full State Summary & Deterministic Invariant Audit
      if ((pathname === '/api/state' || pathname === '/api/status') && req.method === 'GET') {
        const address = urlObj.searchParams.get('address') || '';
        const summary = engine.getStateSummary(address);
        if (requireChain) {
          try {
            const bank = await cachedExplorer(engine.bankAddress);
            const dev = await cachedExplorer(DEV_RESERVE_ADDRESS);
            let player = null;
            if (address && isValidPoaAddress(address)) {
              const row = await cachedExplorer(address);
              player = {
                address: row.address,
                balance: row.balance,
                spendable: formatMicros(spendableMicros(row.balance, chainDebits, row.address))
              };
            }
            summary.chain = {
              ok: true,
              node: watcher.nodeUrl,
              bank: { address: bank.address, balance: bank.balance },
              dev: { address: dev.address, balance: dev.balance },
              player,
              error: null
            };
          } catch (err) {
            summary.chain = {
              ok: false,
              node: watcher.nodeUrl,
              error: redactSecrets(err.message || 'chain unavailable')
            };
          }
        }
        return sendJson(res, 200, summary);
      }

      if (pathname === '/api/audit' && req.method === 'GET') {
        return sendJson(res, 200, engine.verifySystemInvariants());
      }

      // 4. Quote Endpoints
      if (pathname === '/api/quote/bet' && (req.method === 'POST' || req.method === 'GET')) {
        const body = req.method === 'POST' ? await readJsonBody(req) : Object.fromEntries(urlObj.searchParams);
        const quote = engine.quoteBet({
          address: body.address || '',
          amountPoa: body.amountPoa || body.amount_poa || '10.000000',
          targetBps: Number(body.targetBps ?? body.target_bps ?? 4950),
          direction: body.direction || 'under'
        });
        return sendJson(res, 200, quote);
      }

      if (pathname === '/api/quote/deposit' && (req.method === 'POST' || req.method === 'GET')) {
        const body = req.method === 'POST' ? await readJsonBody(req) : Object.fromEntries(urlObj.searchParams);
        const quote = engine.quoteDeposit({
          address: body.address || '',
          amountPoa: body.amountPoa || body.amount_poa || '100.000000',
          lockEpochs: Number(body.lockEpochs ?? body.lock_epochs ?? 0)
        });
        return sendJson(res, 200, quote);
      }

      if (pathname === '/api/quote/withdraw' && (req.method === 'POST' || req.method === 'GET')) {
        const body = req.method === 'POST' ? await readJsonBody(req) : Object.fromEntries(urlObj.searchParams);
        const quote = engine.quoteWithdraw({
          address: body.address || '',
          mode: body.mode || 'ALL',
          bpsToRedeem: body.bpsToRedeem ?? body.bps,
          sharesToRedeem: body.sharesToRedeem ?? body.shares
        });
        return sendJson(res, 200, quote);
      }

      // 5. Submit Pre-Signed POA Transaction (Self-Custody Ed25519 Verified)
      if (pathname === '/api/tx/submit' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const txEnvelope = body.tx || body;
        const receipt = watcher.processSignedTransaction(txEnvelope);
        return sendJson(res, 200, { ok: true, receipt });
      }

      // 6. Client/Agent Local Wallet Generator & Sign-and-Submit Helper
      if (pathname === '/api/wallet/generate' && req.method === 'POST') {
        const kp = genKeypair();
        return sendJson(res, 200, {
          address: kp.address,
          pubkey: kp.pubkey,
          privkey: kp.privkey,
          note: 'Generated Ed25519 PoA wallet. Keep privkey in local storage / memory only.'
        });
      }

      if (pathname === '/api/action/sign-and-submit' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const wallet = body.privkey ? walletFromPrivkey(body.privkey) : genKeypair();
        const action = String(body.action || 'BET').toUpperCase();
        const memo = formatDiceMemo({
          action,
          direction: body.direction || 'under',
          targetBps: Number(body.targetBps ?? 4950),
          clientSeed: body.clientSeed || 'web-client',
          lockEpochs: Number(body.lockEpochs || 0),
          referrer: body.referrer || null,
          shares: body.shares || null,
          bps: body.bps || (body.mode === 'ALL' ? 10000 : null),
          text: body.text || ''
        });
        const amount =
          action === 'LP_WITHDRAW' || action === 'CHAT' || action === 'CLAIM'
            ? '0.000001'
            : String(body.amountPoa || '10.000000');
        if (action === 'BET' || action === 'LP_ADD') {
          await assertChainSpendable(wallet.address, amount);
        }
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount,
          memo,
          nonce: Number(body.nonce || Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000))
        });
        const receipt = watcher.processSignedTransaction(signedTx);
        if ((action === 'BET' || action === 'LP_ADD') && (receipt?.action === 'BET_SETTLED' || receipt?.action === 'LP_DEPOSIT')) {
          noteChainDebit(wallet.address, signedTx.id, amount);
        }
        return sendJson(res, 200, {
          ok: true,
          signerAddress: wallet.address,
          signedTx,
          receipt
        });
      }

      if (pathname === '/api/action/auto-bet' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const wallet = body.privkey ? walletFromPrivkey(body.privkey) : genKeypair();
        const rolls = Math.max(1, Math.min(25, Number(body.rolls ?? 5)));
        const each = String(body.baseWagerPoa || body.amountPoa || '10.000000');
        await assertChainSpendable(wallet.address, fromMicros(toMicros(each) * BigInt(rolls)));
        const result = watcher.executeAutoStrategy({
          wallet,
          strategy: body.strategy || 'quarter_kelly',
          baseWagerPoa: each,
          targetBps: Number(body.targetBps ?? 4950),
          direction: body.direction || 'under',
          rolls,
          clientSeed: body.clientSeed || 'web-auto-strategy',
          stopOnProfitPoa: body.stopOnProfitPoa || null,
          stopOnLossPoa: body.stopOnLossPoa || null
        });
        for (const receipt of result.receipts || []) {
          if (receipt?.betTxid && receipt.wagerPoa) noteChainDebit(wallet.address, receipt.betTxid, receipt.wagerPoa);
        }
        return sendJson(res, 200, result);
      }

      // 7. Provably Fair Verification & Seed Rotation
      if (pathname === '/api/verify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const verification = verifyRoll({
          serverSeed: body.serverSeed || body.server_seed,
          serverSeedHash: body.serverSeedHash || body.server_seed_hash,
          clientSeed: body.clientSeed || body.client_seed || 'default',
          nonce: Number(body.nonce || 1),
          betTxid: body.betTxid || body.bet_txid || '0',
          targetBps: Number(body.targetBps ?? body.target_bps ?? 4950),
          direction: body.direction || 'under'
        });
        return sendJson(res, 200, verification);
      }

      if (pathname === '/api/seed/rotate' && req.method === 'POST') {
        const rotated = engine.seedManager.rotateSeed();
        engine._saveToDisk();
        engine._emit('seed.rotated', rotated);
        return sendJson(res, 200, { ok: true, ...rotated });
      }

      // 8. 0.1% Dev Reserve Sweep (Strictly to poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U)
      if (pathname === '/api/dev/sweep' && req.method === 'POST') {
        const resSweep = engine.sweepDevReserve();
        watcher.flushOutboundQueueSync();
        return sendJson(res, 200, { ok: true, ...resSweep });
      }

      // 9. Epoch Advance & Agent Staking Incentive Compounding
      if (pathname === '/api/epoch/advance' && req.method === 'POST') {
        const resEpoch = engine.advanceEpoch({ distributeIncentives: true });
        return sendJson(res, 200, { ok: true, ...resEpoch });
      }

      // 10. Live Chat Endpoints
      if (pathname === '/api/chat' && req.method === 'GET') {
        const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get('limit') || 50)));
        return sendJson(res, 200, {
          messages: engine.chatMessages.slice(0, limit)
        });
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let addr = body.address || '';
        let sig = body.signature || null;
        if (body.privkey) {
          const w = walletFromPrivkey(body.privkey);
          addr = w.address;
          sig = signRaw(body.text || '', w.privRaw);
        }
        const verified = Boolean(sig && isValidPoaAddress(addr) && verifyRaw(body.text || '', sig, addr));
        const msg = engine.postChatMessage({
          address: addr,
          senderName: body.senderName || body.sender_name || '',
          text: body.text || '',
          isAgent: Boolean(body.isAgent || body.is_agent),
          signature: verified ? sig : null,
          verified
        });
        return sendJson(res, 200, { ok: true, message: msg });
      }

      // 11. Model Context Protocol (MCP) Streamable HTTP Endpoint (/mcp)
      if (pathname === '/mcp' && req.method === 'GET') {
        return sendJson(res, 200, {
          name: 'poa-dice-mcp',
          version: '1.0.0',
          transport: 'streamable-http',
          endpoint: '/mcp',
          toolsCount: MCP_TOOLS.length,
          tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description }))
        });
      }

      if (pathname === '/mcp' && req.method === 'POST') {
        const rpcReq = await readJsonBody(req);
        const rpcRes = await mcpHandler.handleRpc(rpcReq);
        if (rpcRes === null) {
          res.writeHead(202, { 'Access-Control-Allow-Origin': '*' });
          res.end();
          return;
        }
        return sendJson(res, 200, rpcRes);
      }

      // 12. Static Responsive Web UI
      let relPath = pathname === '/' ? '/index.html' : pathname;
      relPath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = path.join(PUBLIC_DIR, relPath);
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      return sendJson(res, 404, { error: `Route not found: ${pathname}` });
    } catch (err) {
      return sendJson(res, err.status || 400, {
        ok: false,
        error: redactSecrets(err.message || 'Bad request')
      });
    }
  });

  return {
    server,
    engine,
    watcher,
    mcpHandler,
    async listen(port = Number(process.env.PORT || 3080), host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const addr = server.address();
      return {
        port: addr.port,
        host: addr.address,
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`
      };
    },
    async close() {
      watcher.stopPolling();
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3080);
  const host = process.env.HOST || '127.0.0.1';
  const app = createDiceServer({
    watcherMode: process.env.POA_DICE_WATCHER_MODE || 'hybrid',
    initialBootstrapPoa: process.env.POA_DICE_BOOTSTRAP_POA || null
  });
  if (app.watcher.mode !== 'simulated') app.watcher.startPolling(20000);
  app.listen(port, host).then((info) => {
    console.log(`POA Dice & Bankroll Vault live at ${info.url}`);
    console.log(`  MCP Endpoint : ${info.url}/mcp`);
    console.log(`  SSE Stream   : ${info.url}/api/stream`);
    console.log(`  Bank Address : ${app.engine.bankAddress}`);
    console.log(`  Dev Reserve  : ${DEV_RESERVE_ADDRESS} (0.1% reserved)`);
  });
}
