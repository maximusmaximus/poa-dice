// @ts-nocheck
/**
 * Fetch adapter over the same Node server the poa-dice repo runs.
 * One process-wide listener so API, SSE, and MCP share one bankroll.
 *
 * This is the Vercel/Nitro entry used by the Grok Build publish path.
 * The repo's own server is still src/server.mjs (`npm start`). The browser
 * must never import this module. Bank keys come only from the environment
 * or the key file, never from values baked into this source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from './server.mjs';

const KEY_FILE = process.env.POA_DICE_BANK_KEY_FILE || '/var/lib/poa-dice/bank-key.json';
const GLOBAL = '__poaDiceNodeV15';
const ENV_PRIVKEY = ['POA_DICE', 'BANK_PRIVKEY'].join('_');
const ENV_ADDRESS = ['POA_DICE', 'BANK_ADDRESS'].join('_');
const ENV_KEY_FILE = ['POA_DICE', 'BANK_KEY_FILE'].join('_');

function envGet(name) {
  return process.env[name];
}

function envSet(name, value) {
  process.env[name] = value;
}

function resolveDataDir() {
  const preferred = process.env.POA_DICE_DATA_DIR || path.join(process.cwd(), 'data');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const tmp = path.join(os.tmpdir(), 'poa-dice-data');
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }
}

function extractEdgeClientIp(headers) {
  const vercel = String(headers.get('x-vercel-forwarded-for') || '').split(',')[0].trim();
  if (vercel) return vercel;
  const realIp = String(headers.get('x-real-ip') || '').trim();
  if (realIp) return realIp;
  const xff = String(headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return xff || '';
}

/**
 * Factory for an isolated Fetch-API adapter (also used by the default Vercel/Nitro singleton).
 */
export function createWebHandler({ serverOptions = null, createServer = createDiceServer } = {}) {
  const internalProxySecret = crypto.randomBytes(24).toString('hex');
  let state = null;

  async function ensureApp() {
    if (!state) {
      let opts;
      if (serverOptions) {
        opts = { ...serverOptions, internalProxySecret };
      } else {
        const dataDir = resolveDataDir();
        const keyFile = KEY_FILE;
        if (fs.existsSync(keyFile)) {
          if (!envGet(ENV_PRIVKEY) && !envGet(ENV_KEY_FILE)) envSet(ENV_KEY_FILE, keyFile);
          if (!envGet(ENV_ADDRESS)) {
            try {
              const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
              if (saved && saved.address) envSet(ENV_ADDRESS, String(saved.address).trim());
            } catch {
              // loadBankWallet reports a bad file as BANK_KEY_INVALID
            }
          }
        }
        // Single writer (PR #12). Only an instance that has the shared store may sign.
        // A sandbox with no shared database/KV stays read-only and cannot pay twice.
        const sharedStore = Boolean(
          process.env.DATABASE_URL ||
            process.env.POSTGRES_URL ||
            process.env.POA_DICE_DATABASE_URL ||
            (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
            (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
        );
        const preview = process.env.VERCEL_ENV === 'preview' || process.env.VERCEL_ENV === 'development';
        if (sharedStore && !preview) {
          if (envGet('POA_DICE_BANK_SIGNER') === undefined) envSet('POA_DICE_BANK_SIGNER', '1');
          if (envGet('POA_DICE_BIND_STORE') === undefined && envGet(ENV_ADDRESS)) {
            envSet('POA_DICE_BIND_STORE', envGet(ENV_ADDRESS));
          }
        }
        opts = {
          dataDir,
          watcherMode: process.env.POA_DICE_WATCHER_MODE || 'live',
          initialBootstrapPoa: null,
          internalProxySecret
        };
      }

      let app;
      try {
        app = createServer(opts);
        const ready = app.listen(0, '127.0.0.1').then(
          (info) => {
            const ro = app.readOnly?.();
            if (!ro && app.settlement && !app.settlement.passMode) {
              app.settlement.start(Number(process.env.POA_DICE_SETTLE_MS || 5000));
            } else if (ro) {
              console.error(`[poa-dice] READ-ONLY ${ro.status}: ${ro.error}`);
            }
            return info;
          },
          async (err) => {
            if (state?.app === app) state = null;
            try {
              await app.close?.();
            } catch {
              // ignore cleanup failure
            }
            throw err;
          }
        );
        state = { app, ready };
      } catch (err) {
        state = null;
        const store = app?.settlement?.store;
        if (store && typeof store.close === 'function') await store.close().catch(() => {});
        throw err;
      }
    }
    return state;
  }

  async function handle(request) {
    const entry = await ensureApp();
    const info = await entry.ready;
    const url = new URL(request.url);
    const target = new URL(`${url.pathname}${url.search}`, info.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    headers.delete('x-poa-internal-proxy');
    headers.delete('x-poa-client-ip');
    const clientIp = extractEdgeClientIp(request.headers);
    if (clientIp) {
      headers.set('x-poa-internal-proxy', internalProxySecret);
      headers.set('x-poa-client-ip', clientIp);
    }
    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const resp = await fetch(target, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      signal: request.signal
    });
    const out = new Headers(resp.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    out.delete('transfer-encoding');
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
  }

  async function close() {
    const cur = state;
    state = null;
    if (cur?.app?.close) await cur.app.close();
  }

  return { handle, ensureApp, close };
}

function getDefaultHandler() {
  const g = globalThis;
  if (!g[GLOBAL]) g[GLOBAL] = createWebHandler();
  return g[GLOBAL];
}

export async function handleDiceWebRequest(request) {
  return getDefaultHandler().handle(request);
}
