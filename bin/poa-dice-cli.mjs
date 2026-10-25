#!/usr/bin/env node
/**
 * bin/poa-dice-cli.mjs — Website-Independent CLI for POA Dice & Shared Bankroll Vault
 *
 * Works against a live poa-dice server (--server http://127.0.0.1:3080) OR
 * 100% offline/headless directly against the local state & DICE1:* memo protocol
 * (--offline) so users and agents never depend on the website being online.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  genKeypair,
  walletFromPrivkey,
  buildSignedTransfer,
  formatDiceMemo,
  redactSecrets,
} from '../src/crypto-poa.mjs';
import { BankrollEngine, DEV_RESERVE_ADDRESS } from '../src/bankroll-engine.mjs';
import { LedgerWatcher } from '../src/ledger-watcher.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

function loadOrCreateLocalWallet(walletDir) {
  const dir = walletDir || path.join(os.homedir(), '.poa-dice-wallet');
  const keyFile = path.join(dir, 'key');
  const addrFile = path.join(dir, 'address');
  if (fs.existsSync(keyFile)) {
    const priv = fs.readFileSync(keyFile, 'utf8').trim();
    return walletFromPrivkey(priv);
  }
  fs.mkdirSync(dir, { recursive: true });
  const kp = genKeypair();
  fs.writeFileSync(keyFile, kp.privkey + '\n', { mode: 0o600 });
  fs.writeFileSync(addrFile, kp.address + '\n', { mode: 0o644 });
  return kp;
}

async function tryHttp(serverUrl, endpoint, options = {}) {
  const url = `${serverUrl.replace(/\/$/, '')}${endpoint}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  const serverUrl = args.server || process.env.POA_DICE_URL || 'http://127.0.0.1:3080';
  const forceOffline = Boolean(args.offline);
  const dataDir = args.dataDir || args.state || path.join(process.cwd(), 'data');

  const wallet = loadOrCreateLocalWallet(args.wallet);

  async function withOfflineFallback(httpFn, localFn) {
    if (!forceOffline) {
      try {
        return await httpFn();
      } catch {
        // Server unreachable — fall back to 100% website-independent local execution
      }
    }
    const engine = new BankrollEngine({
      dataDir,
      initialBootstrapPoa: '250000.000000',
      bootstrapAddress: DEV_RESERVE_ADDRESS,
    });
    const watcher = new LedgerWatcher({ engine, mode: 'simulated' });
    return await localFn(engine, watcher);
  }

  let output;

  if (cmd === 'status') {
    output = await withOfflineFallback(
      () => tryHttp(serverUrl, `/api/state?address=${encodeURIComponent(wallet.address)}`),
      (engine) => ({
        ok: true,
        mode: 'offline-direct-engine',
        walletAddress: wallet.address,
        state: engine.getStateSummary(wallet.address),
      })
    );
  } else if (cmd === 'quote-bet') {
    const amountPoa = String(args.amount || '10.000000');
    const direction = args.over ? 'over' : 'under';
    const targetFloat = Number(args.over || args.under || 49.5);
    const targetBps = Math.round(targetFloat * 100);
    output = await withOfflineFallback(
      () =>
        tryHttp(
          serverUrl,
          `/api/quote/bet?amountPoa=${encodeURIComponent(amountPoa)}&targetBps=${targetBps}&direction=${direction}&address=${wallet.address}`
        ),
      (engine) => ({
        ok: true,
        mode: 'offline-direct-engine',
        quote: engine.quoteBet({ address: wallet.address, amountPoa, targetBps, direction }),
      })
    );
  } else if (cmd === 'bet') {
    const amountPoa = String(args.amount || '10.000000');
    const direction = args.over ? 'over' : 'under';
    const targetFloat = Number(args.over || args.under || 49.5);
    const targetBps = Math.round(targetFloat * 100);
    const clientSeed = String(args.seed || 'cli-agent-seed-01');
    const memo = formatDiceMemo({ action: 'BET', direction, targetBps, clientSeed });

    output = await withOfflineFallback(
      async () => {
        const state = await tryHttp(serverUrl, '/api/state');
        const signedTx = buildSignedTransfer({
          wallet,
          to: state.bankAddress,
          amount: amountPoa,
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
        });
        return await tryHttp(serverUrl, '/api/tx/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx: signedTx }),
        });
      },
      (engine, watcher) => {
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount: amountPoa,
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
        });
        return {
          ok: true,
          mode: 'offline-direct-engine',
          receipt: watcher.processSignedTransaction(signedTx),
        };
      }
    );
  } else if (cmd === 'quote-deposit') {
    const amountPoa = String(args.amount || '1000.000000');
    const lockEpochs = Number(args.epochs || 4);
    output = await withOfflineFallback(
      () =>
        tryHttp(
          serverUrl,
          `/api/quote/deposit?amountPoa=${encodeURIComponent(amountPoa)}&lockEpochs=${lockEpochs}&address=${wallet.address}`
        ),
      (engine) => ({
        ok: true,
        mode: 'offline-direct-engine',
        quote: engine.quoteDeposit({ address: wallet.address, amountPoa, lockEpochs }),
      })
    );
  } else if (cmd === 'stake') {
    const amountPoa = String(args.amount || '1000.000000');
    const lockEpochs = args.epochs !== undefined ? Number(args.epochs) : 4;
    const memo = formatDiceMemo({ action: 'LP_ADD', lockEpochs, referrer: args.ref || null });

    output = await withOfflineFallback(
      async () => {
        const state = await tryHttp(serverUrl, '/api/state');
        const signedTx = buildSignedTransfer({
          wallet,
          to: state.bankAddress,
          amount: amountPoa,
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
        });
        return await tryHttp(serverUrl, '/api/tx/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx: signedTx }),
        });
      },
      (engine, watcher) => {
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount: amountPoa,
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
        });
        return {
          ok: true,
          mode: 'offline-direct-engine',
          receipt: watcher.processSignedTransaction(signedTx),
        };
      }
    );
  } else if (cmd === 'withdraw') {
    const bps = Number(args.bps || 10000);
    const memo = formatDiceMemo({ action: 'LP_WITHDRAW', bps });

    output = await withOfflineFallback(
      async () => {
        const state = await tryHttp(serverUrl, '/api/state');
        const signedTx = buildSignedTransfer({
          wallet,
          to: state.bankAddress,
          amount: '0.000001',
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
        });
        return await tryHttp(serverUrl, '/api/tx/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx: signedTx }),
        });
      },
      (engine, watcher) => {
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount: '0.000001',
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
        });
        return {
          ok: true,
          mode: 'offline-direct-engine',
          receipt: watcher.processSignedTransaction(signedTx),
        };
      }
    );
  } else if (cmd === 'chat') {
    const text = String(args.message || 'Hello from poa-dice CLI!');
    const memo = formatDiceMemo({ action: 'CHAT', text });
    output = await withOfflineFallback(
      () =>
        tryHttp(serverUrl, '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: wallet.address,
            senderName: args.name || 'CLI-Agent',
            text,
            isAgent: true,
          }),
        }),
      (engine, watcher) => {
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount: '0.000001',
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
        });
        return {
          ok: true,
          mode: 'offline-direct-engine',
          receipt: watcher.processSignedTransaction(signedTx),
        };
      }
    );
  } else if (cmd === 'sweep-dev') {
    output = await withOfflineFallback(
      () => tryHttp(serverUrl, '/api/dev/sweep', { method: 'POST' }),
      (engine) => ({
        ok: true,
        mode: 'offline-direct-engine',
        ...engine.sweepDevReserve(),
      })
    );
  } else if (cmd === 'offline-tx') {
    const action = String(args.action || 'BET').toUpperCase();
    const amountPoa = String(args.amount || '10.000000');
    const direction = args.over ? 'over' : 'under';
    const targetBps = Math.round(Number(args.over || args.under || 49.5) * 100);
    const memo = formatDiceMemo({
      action,
      direction,
      targetBps,
      clientSeed: args.seed || 'offline-seed-01',
      lockEpochs: Number(args.epochs || 0),
      bps: Number(args.bps || 10000),
      text: args.message || 'Offline memo',
    });
    const toAddr = args.to || DEV_RESERVE_ADDRESS;
    const signedTx = buildSignedTransfer({
      wallet,
      to: toAddr,
      amount: amountPoa,
      memo,
    });
    output = {
      ok: true,
      mode: 'pure-on-chain-memo-builder',
      walletAddress: wallet.address,
      memo,
      signedTransaction: signedTx,
      poaCliCommand: `node poa.mjs send --node https://minepoa.com --wallet ~/.poa --to ${toAddr} --amount ${amountPoa} --memo "${memo}"`,
    };
  } else {
    output = {
      ok: false,
      error: `Unknown command: ${cmd}. Supported: status, quote-bet, bet, quote-deposit, stake, withdraw, chat, sweep-dev, offline-tx`,
    };
  }

  console.log(redactSecrets(JSON.stringify(output, null, 2), wallet.privkey));
}

main().catch((err) => {
  console.error(redactSecrets(JSON.stringify({ ok: false, error: err.message })));
  process.exit(1);
});
