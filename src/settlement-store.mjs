// @ts-nocheck
/**
 * settlement-store.mjs: durable JSON document store for the vault (settlement queue + engine snapshot).
 *
 * Adapter interface:  { kind, location, durable, load(): doc|null|Promise, save(doc): void|Promise }
 *   save must be durable when it returns / resolves.
 *
 * - redis (Upstash REST / Vercel KV): the right choice on serverless or container hosts whose disk
 *   and memory are recycled. Env: KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV / Upstash
 *   integration) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 * - file: atomic write (tmp + fsync + rename). Durable ONLY on a persistent disk; it is marked
 *   durable only when POA_DICE_DATA_DIR is set explicitly and the host is not Vercel.
 * - memory: tests only.
 *
 * resolveStore() picks one. When the best it can do is an ephemeral file, `durable` is false and the
 * server refuses to take player funds (read-only, STORAGE_EPHEMERAL) unless
 * POA_DICE_ALLOW_EPHEMERAL=1 is set (then the vault relies on ledger replay; see chain-settlement).
 */
import fs from 'node:fs';
import path from 'node:path';

export function createFileStore(dir, name = 'settlement.json') {
  const file = path.join(dir, name);
  return {
    kind: 'file',
    location: file,
    durable: true,
    load() {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    save(doc) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(doc, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    }
  };
}

export function createMemoryStore(initial = null) {
  let doc = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    kind: 'memory',
    location: 'memory',
    durable: true,
    load: () => (doc ? JSON.parse(JSON.stringify(doc)) : null),
    save: (d) => {
      doc = JSON.parse(JSON.stringify(d));
    }
  };
}

/** True when dir is writable (probe file). */
export function isWritableDir(dir) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Upstash Redis REST adapter (also Vercel KV). One JSON document under `key`.
 * Uses plain fetch, so it works on Node 18+, Vercel and Cloudflare alike.
 */
export function createRedisRestStore({ url, token, key, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  if (!url || !token) throw new Error('Redis REST store needs url and token');
  const base = String(url).replace(/\/+$/, '');
  const call = async (cmd) => {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await fetchImpl(base, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(cmd),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j.error) throw new Error(`KV ${cmd[0]} failed: ${j.error || `HTTP ${resp.status}`}`);
        return j.result;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
    throw lastErr;
  };
  return {
    kind: 'redis',
    location: `${base.replace(/^https?:\/\//, '').split('/')[0]}#${key}`,
    durable: true,
    async load() {
      const raw = await call(['GET', key]);
      return raw ? JSON.parse(raw) : null;
    },
    async save(doc) {
      await call(['SET', key, JSON.stringify(doc)]);
    }
  };
}

/**
 * Pick the vault store for this host.
 *   env.KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/_TOKEN -> redis (durable)
 *   explicit persistent data dir (POA_DICE_DATA_DIR, or options.dataDirIsPersistent) on a non-Vercel host -> file (durable)
 *   otherwise a writable dir -> file marked durable:false (ephemeral)
 */
export function resolveStore({ env = process.env, dataDir, dataDirIsPersistent = false, keyPrefix = 'poa-dice', bankAddress = 'bank', fetchImpl } = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return createRedisRestStore({ url, token, key: `${env.POA_DICE_KV_KEY || keyPrefix}:${bankAddress}:vault`, fetchImpl });
  }
  if (dataDir && isWritableDir(dataDir)) {
    const store = createFileStore(dataDir);
    const onVercel = Boolean(env.VERCEL || env.VERCEL_ENV);
    store.durable = Boolean(dataDirIsPersistent || env.POA_DICE_DATA_DIR) && !onVercel;
    return store;
  }
  return null;
}

/**
 * Ordered write-behind queue in front of a (possibly async) store.
 * save() snapshots the doc immediately (so later mutations cannot leak into an earlier write);
 * flush() resolves once everything saved so far is durable, and rejects if a write failed.
 * Sync stores (file/memory) are written immediately, inside save().
 */
export class PersistQueue {
  constructor(store) {
    this.store = store;
    this.async = store.async === true || store.kind === 'redis';
    this._chain = Promise.resolve();
    this._pending = null;
    this._error = null;
    this.writes = 0;
  }

  save(doc) {
    const snapshot = JSON.stringify(doc);
    if (!this.async) {
      this.store.save(JSON.parse(snapshot)); // sync stores: durable on return (throws on failure)
      this.writes += 1;
      return;
    }
    this._pending = snapshot; // coalesce: only the newest full snapshot needs writing
    this._schedule();
  }

  _schedule() {
    this._chain = this._chain.then(async () => {
      if (this._pending === null) return;
      const next = this._pending;
      this._pending = null;
      try {
        await this.store.save(JSON.parse(next));
        this.writes += 1;
        this._error = null;
      } catch (err) {
        this._error = err;
        if (this._pending === null) this._pending = next; // retried by the next save()/flush()
      }
    });
  }

  /** Resolves once every save() so far is durable; rejects if the store is failing. */
  async flush() {
    if (!this.async) return;
    if (this._pending !== null) this._schedule();
    await this._chain;
    if (this._error) throw this._error;
  }
}
