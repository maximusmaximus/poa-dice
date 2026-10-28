// @ts-nocheck
/**
 * settlement-store.mjs: durable JSON document store for the vault (settlement queue + engine snapshot).
 *
 * Adapter interface:  { kind, location, durable, load(): doc|null|Promise, save(doc): void|Promise,
 *                      claim(key, value): {claimed, value}|Promise,
 *                      reserveCapacity(scope, key, micros, limitMicros, ttlMs): {ok, usedMicros}|Promise,
 *                      releaseCapacity(scope, key, micros|null): void|Promise,
 *                      capacityUsed(scope): micros(BigInt-able string)|Promise }
 *   reserveCapacity atomically adds a reservation only if (sum of live reservations in scope) + micros
 *   <= limitMicros, across every instance sharing the store. Reservations expire after ttlMs so a
 *   crashed instance cannot leak capacity forever. Used for bank coverage of unsettled bets.
 *   save must be durable when it returns / resolves.
 *   claim is an atomic insert-if-absent shared by every server instance using the same store:
 *   the first caller stores `value` and gets {claimed:true, value}; every later caller (any instance)
 *   gets {claimed:false, value:<the first value>}. It is what makes a bet settle exactly once
 *   (one roll, one payout note) and a payout get signed exactly once, even when two serverless
 *   instances hold their own copy of the vault document at the same time.
 *
 * - postgres: DATABASE_URL / POSTGRES_URL (Vercel Postgres, Neon, Supabase...). Document in
 *   poa_dice_docs, claims in poa_dice_claims via INSERT ... ON CONFLICT DO NOTHING.
 *
 * - redis (Upstash REST / Vercel KV): the right choice on serverless or container hosts whose disk
 *   and memory are recycled. Env: KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV / Upstash
 *   integration) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 * - file: atomic write (tmp + fsync + rename). Durable ONLY on a persistent disk; it is marked
 *   durable only when POA_DICE_DATA_DIR is set explicitly and the host is not Vercel.
 * - memory: tests only.
 *
 * Single-writer support (see bank-writer.mjs): postgres, file and memory stores also implement
 *   peek(key): the claimed value or null (never creates),
 *   lease(name, holder, ttlMs): {held, holder, token, expiresAt} - one holder at a time; the fencing
 *     token increases every time the lease changes hands,
 *   releaseLease(name, holder).
 * Postgres additionally fences document writes: once setFence({name, holder, token}) is called, a save
 * only lands while that lease is still held with that token. Redis has no lease support, so a vault on
 * Redis never signs bank transactions (read-only).
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
    },
    claim(key, value) {
      const cdir = path.join(dir, 'claims');
      fs.mkdirSync(cdir, { recursive: true });
      const f = path.join(cdir, `${claimFileName(key)}.json`);
      try {
        const fd = fs.openSync(f, 'wx'); // O_CREAT|O_EXCL: atomic insert-if-absent
        try {
          fs.writeSync(fd, JSON.stringify(value));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return { claimed: true, value: JSON.parse(JSON.stringify(value)) };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        return { claimed: false, value: JSON.parse(fs.readFileSync(f, 'utf8')) };
      }
    },
    reserveCapacity(scope, key, micros, limitMicros, ttlMs = 30 * 60 * 1000) {
      return withFileLock(dir, `cap-${claimFileName(scope)}`, (book) => capReserve(book, key, micros, limitMicros, ttlMs));
    },
    releaseCapacity(scope, key, micros = null) {
      return withFileLock(dir, `cap-${claimFileName(scope)}`, (book) => capRelease(book, key, micros));
    },
    capacityUsed(scope) {
      const f = path.join(dir, 'claims', `cap-${claimFileName(scope)}.json`);
      return fs.existsSync(f) ? capUsed(JSON.parse(fs.readFileSync(f, 'utf8'))) : '0';
    },
    peek(key) {
      const f = path.join(dir, 'claims', `${claimFileName(key)}.json`);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    },
    lease(name, holder, ttlMs) {
      return withFileLock(dir, `lease-${claimFileName(name)}`, (book) => leaseBook(book, holder, ttlMs, Date.now()));
    },
    releaseLease(name, holder) {
      return withFileLock(dir, `lease-${claimFileName(name)}`, (book) => {
        if (book.holder === holder) book.expiresAt = 0;
      });
    },
    putStatus(name, value) {
      return withFileLock(dir, `status-${claimFileName(name)}`, (book) => {
        for (const k of Object.keys(book)) delete book[k];
        Object.assign(book, { value: JSON.parse(JSON.stringify(value)) });
      });
    },
    getStatus(name) {
      const f = path.join(dir, 'claims', `status-${claimFileName(name)}.json`);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).value ?? null : null;
    }
  };
}

/**
 * Lease state machine shared by the memory and file stores. Free or expired -> taken (token + 1);
 * held by the same holder -> renewed (same token); held by someone else -> refused.
 */
export function leaseBook(book, holder, ttlMs, nowMs) {
  const live = book.holder && Number(book.expiresAt || 0) > nowMs;
  if (live && book.holder !== holder) return { held: false, holder: book.holder, token: Number(book.token || 0), expiresAt: Number(book.expiresAt) };
  if (!live || book.holder !== holder) {
    book.token = Number(book.token || 0) + 1;
    book.holder = holder;
  }
  book.expiresAt = nowMs + ttlMs;
  return { held: true, holder, token: book.token, expiresAt: book.expiresAt };
}

/** Read-modify-write a JSON book under an O_EXCL lock file (single host, many processes). */
function withFileLock(dir, name, fn) {
  const cdir = path.join(dir, 'claims');
  fs.mkdirSync(cdir, { recursive: true });
  const lock = path.join(cdir, `${name}.lock`);
  const file = path.join(cdir, `${name}.json`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock); // stale lock
      } catch {
        // ignore
      }
      if (Date.now() > deadline) throw new Error('capacity lock busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    const book = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const out = fn(book);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(book));
    fs.renameSync(tmp, file);
    return out;
  } finally {
    fs.unlinkSync(lock);
  }
}

/** Capacity book on a plain object { [key]: { micros, exp } }; returns the updated book or null. */
function capReserve(book, key, micros, limitMicros, ttlMs, nowMs = Date.now()) {
  let used = 0n;
  for (const [k, r] of Object.entries(book)) {
    if (r.exp <= nowMs) {
      delete book[k];
      continue;
    }
    used += BigInt(r.micros);
  }
  if (book[key]) return { ok: true, usedMicros: used.toString(), existing: true };
  const m = BigInt(micros);
  if (used + m > BigInt(limitMicros)) return { ok: false, usedMicros: used.toString() };
  book[key] = { micros: m.toString(), exp: nowMs + ttlMs };
  return { ok: true, usedMicros: (used + m).toString() };
}

function capRelease(book, key, micros) {
  const r = book[key];
  if (!r) return;
  const left = micros === null || micros === undefined ? 0n : BigInt(r.micros) - BigInt(micros);
  if (left > 0n) r.micros = left.toString();
  else delete book[key];
}

function capUsed(book, nowMs = Date.now()) {
  let used = 0n;
  for (const r of Object.values(book)) if (r.exp > nowMs) used += BigInt(r.micros);
  return used.toString();
}

function claimFileName(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}

/** Claims table shared by every memory store built with it (tests use it to simulate two instances). */
export function createClaimTable() {
  return new Map();
}

export function createMemoryStore(initial = null, { claims = createClaimTable() } = {}) {
  let doc = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    claims,
    claim(key, value) {
      if (claims.has(key)) return { claimed: false, value: JSON.parse(claims.get(key)) };
      claims.set(key, JSON.stringify(value));
      return { claimed: true, value: JSON.parse(JSON.stringify(value)) };
    },
    reserveCapacity(scope, key, micros, limitMicros, ttlMs = 30 * 60 * 1000) {
      const k = `__capacity__:${scope}`;
      if (!claims.has(k)) claims.set(k, {});
      return capReserve(claims.get(k), key, micros, limitMicros, ttlMs);
    },
    releaseCapacity(scope, key, micros = null) {
      const book = claims.get(`__capacity__:${scope}`);
      if (book) capRelease(book, key, micros);
    },
    capacityUsed(scope) {
      return capUsed(claims.get(`__capacity__:${scope}`) || {});
    },
    peek(key) {
      return claims.has(key) ? JSON.parse(claims.get(key)) : null;
    },
    lease(name, holder, ttlMs) {
      const k = `__lease__:${name}`;
      const book = claims.has(k) ? JSON.parse(claims.get(k)) : {};
      const out = leaseBook(book, holder, ttlMs, Date.now());
      claims.set(k, JSON.stringify(book));
      return out;
    },
    releaseLease(name, holder) {
      const k = `__lease__:${name}`;
      if (!claims.has(k)) return;
      const book = JSON.parse(claims.get(k));
      if (book.holder === holder) {
        book.expiresAt = 0;
        claims.set(k, JSON.stringify(book));
      }
    },
    putStatus(name, value) {
      claims.set(`__status__:${name}`, JSON.stringify(value));
    },
    getStatus(name) {
      const k = `__status__:${name}`;
      return claims.has(k) ? JSON.parse(claims.get(k)) : null;
    },
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
    },
    async claim(claimKey, value) {
      const k = `${key}:claim:${claimKey}`;
      const ok = await call(['SET', k, JSON.stringify(value), 'NX']);
      if (ok === 'OK') return { claimed: true, value: JSON.parse(JSON.stringify(value)) };
      const raw = await call(['GET', k]);
      if (!raw) throw new Error(`KV claim ${claimKey}: SET NX refused but no value stored`);
      return { claimed: false, value: JSON.parse(raw) };
    },
    // Lua runs atomically in Redis: sum live reservations, add only if within the limit.
    async reserveCapacity(scope, rkey, micros, limitMicros, ttlMs = 30 * 60 * 1000) {
      const r = await call(['EVAL', REDIS_RESERVE_LUA, '1', `${key}:cap:${scope}`, rkey, String(micros), String(limitMicros), String(Date.now()), String(ttlMs)]);
      return { ok: Number(r[0]) === 1, usedMicros: String(r[1]) };
    },
    async releaseCapacity(scope, rkey, micros = null) {
      await call(['EVAL', REDIS_RELEASE_LUA, '1', `${key}:cap:${scope}`, rkey, micros === null || micros === undefined ? '' : String(micros)]);
    },
    async capacityUsed(scope) {
      const r = await call(['EVAL', REDIS_USED_LUA, '1', `${key}:cap:${scope}`, String(Date.now())]);
      return String(r);
    }
  };
}

const REDIS_RESERVE_LUA = `
local now = tonumber(ARGV[4])
local used = 0
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  local m, e = string.match(all[i + 1], '([^:]+):([^:]+)')
  if tonumber(e) <= now then redis.call('HDEL', KEYS[1], all[i]) else used = used + tonumber(m) end
end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return {1, tostring(used)} end
if used + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return {0, tostring(used)} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. ':' .. tostring(now + tonumber(ARGV[5])))
return {1, tostring(used + tonumber(ARGV[2]))}`;
const REDIS_RELEASE_LUA = `
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return 0 end
if ARGV[2] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) return 1 end
local m, e = string.match(v, '([^:]+):([^:]+)')
local left = tonumber(m) - tonumber(ARGV[2])
if left > 0 then redis.call('HSET', KEYS[1], ARGV[1], tostring(left) .. ':' .. e) else redis.call('HDEL', KEYS[1], ARGV[1]) end
return 1`;
const REDIS_USED_LUA = `
local now = tonumber(ARGV[1])
local used = 0
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  local m, e = string.match(all[i + 1], '([^:]+):([^:]+)')
  if tonumber(e) > now then used = used + tonumber(m) end
end
return tostring(used)`;

/**
 * Postgres adapter. `query(text, params)` -> { rows } (defaults to a lazily created node-postgres Pool).
 * The vault document lives in poa_dice_docs; claims in poa_dice_claims (primary key = claim key), so
 * INSERT ... ON CONFLICT DO NOTHING RETURNING is the atomic arbiter across instances.
 */
// Schema for the Postgres store (all idempotent). Setup is serialized with a fixed advisory lock key.
export const PG_SCHEMA_LOCK_KEY = '5778343729120067585'; // fixed bigint, same for every instance
export const PG_TABLES = ['poa_dice_docs', 'poa_dice_claims', 'poa_dice_capacity', 'poa_dice_reservations', 'poa_dice_leases', 'poa_dice_status'];
const PG_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS poa_dice_docs (key TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  'CREATE TABLE IF NOT EXISTS poa_dice_claims (key TEXT PRIMARY KEY, value JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  'CREATE TABLE IF NOT EXISTS poa_dice_capacity (scope TEXT PRIMARY KEY)',
  'CREATE TABLE IF NOT EXISTS poa_dice_reservations (scope TEXT NOT NULL, key TEXT NOT NULL, micros BIGINT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (scope, key))',
  'CREATE TABLE IF NOT EXISTS poa_dice_leases (key TEXT PRIMARY KEY, holder TEXT NOT NULL, token BIGINT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)',
  'CREATE TABLE IF NOT EXISTS poa_dice_status (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'
];

/** Postgres "it already exists" races during CREATE ... IF NOT EXISTS: unique_violation (pg_type/pg_class), duplicate_table, duplicate_object. */
export function isPgAlreadyExists(err) {
  return Boolean(err) && ['23505', '42P07', '42710'].includes(String(err.code || ''));
}

export function createPostgresStore({ connectionString, key, query = null }) {
  if (!query && !connectionString) throw new Error('Postgres store needs a connection string');
  let pool = null;
  let ready = null;
  let fakeTx = Promise.resolve(); // serializes transactions when a custom query fn is injected (tests)
  const getPool = async () => {
    if (!pool) {
      const pg = await import('pg');
      const Pool = pg.Pool || pg.default.Pool;
      pool = new Pool({ connectionString, max: 3, ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false } });
      // An idle connection dropped by the server must not crash the process; the next query reconnects.
      pool.on('error', () => {});
    }
    return pool;
  };
  const q = async (text, params) => {
    if (query) return query(text, params);
    return (await getPool()).query(text, params);
  };
  /** Run fn(query) inside one transaction (BEGIN/COMMIT) on one connection. */
  const tx = async (fn) => {
    if (query) {
      const run = fakeTx.then(() => fn(query));
      fakeTx = run.catch(() => {});
      return run;
    }
    const client = await (await getPool()).connect();
    try {
      await client.query('BEGIN');
      const out = await fn((t, p) => client.query(t, p));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  const init = () => {
    if (!ready) {
      ready = (async () => {
        // Concurrent first boot (two instances creating the same new table at once) can make Postgres raise
        // a unique violation on pg_type even with IF NOT EXISTS. All schema statements run in one
        // transaction behind a fixed advisory lock, and an "already exists" race is treated as success
        // once every table is verified to exist.
        try {
          await tx(async (tq) => {
            await tq('SELECT pg_advisory_xact_lock($1)', [PG_SCHEMA_LOCK_KEY]);
            for (const sql of PG_SCHEMA) await tq(sql);
          });
        } catch (err) {
          if (!isPgAlreadyExists(err)) throw err;
        }
        const r = await q('SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE tablename = ANY($1::text[])', [PG_TABLES]);
        const n = r && r.rows && r.rows[0] ? Number(r.rows[0].n) : null;
        if (n !== null && n !== PG_TABLES.length) throw new Error(`Postgres schema incomplete: ${n} of ${PG_TABLES.length} poa_dice tables exist`);
      })();
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };
  let fence = null; // {name, holder, token}: document writes only land while this lease is held
  return {
    kind: 'postgres',
    async close() {
      if (pool) {
        const p = pool;
        pool = null;
        ready = null;
        await p.end().catch(() => {});
      }
    },
    setFence(f) {
      fence = f ? { ...f } : null;
    },
    async: true,
    location: `postgres#${key}`,
    durable: true,
    async load() {
      await init();
      const r = await q('SELECT doc FROM poa_dice_docs WHERE key = $1', [key]);
      return r.rows[0] ? (typeof r.rows[0].doc === 'string' ? JSON.parse(r.rows[0].doc) : r.rows[0].doc) : null;
    },
    async save(doc) {
      await init();
      if (!fence) {
        await q('INSERT INTO poa_dice_docs (key, doc, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()', [key, JSON.stringify(doc)]);
        return;
      }
      // Fenced write: lands only while our lease (same holder, same token) is still live.
      const r = await q(
        'INSERT INTO poa_dice_docs (key, doc, updated_at) SELECT $1, $2::jsonb, now() WHERE EXISTS (SELECT 1 FROM poa_dice_leases WHERE key = $3 AND holder = $4 AND token = $5 AND expires_at > now()) ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now() RETURNING key',
        [key, JSON.stringify(doc), `${key}:${fence.name}`, fence.holder, String(fence.token)]
      );
      if (!r.rows || !r.rows.length) throw Object.assign(new Error('vault write fenced off: this instance no longer holds the bank writer lease'), { fenced: true });
    },
    async peek(claimKey) {
      await init();
      const r = await q('SELECT value FROM poa_dice_claims WHERE key = $1', [`${key}:${claimKey}`]);
      if (!r.rows[0]) return null;
      const v = r.rows[0].value;
      return typeof v === 'string' ? JSON.parse(v) : v;
    },
    async lease(name, holder, ttlMs) {
      await init();
      const lk = `${key}:${name}`;
      // Take it if free/expired (token + 1), renew if ours (same token), otherwise leave it.
      const r = await q(
        `INSERT INTO poa_dice_leases (key, holder, token, expires_at) VALUES ($1, $2, 1, now() + ($3 || ' milliseconds')::interval)
         ON CONFLICT (key) DO UPDATE SET
           token = CASE WHEN poa_dice_leases.holder = EXCLUDED.holder AND poa_dice_leases.expires_at > now() THEN poa_dice_leases.token ELSE poa_dice_leases.token + 1 END,
           holder = EXCLUDED.holder,
           expires_at = EXCLUDED.expires_at
         WHERE poa_dice_leases.holder = EXCLUDED.holder OR poa_dice_leases.expires_at <= now()
         RETURNING holder, token::text AS token, (extract(epoch from expires_at) * 1000)::bigint::text AS expires_ms`,
        [lk, holder, String(ttlMs)]
      );
      if (r.rows && r.rows[0]) return { held: true, holder, token: Number(r.rows[0].token), expiresAt: Number(r.rows[0].expires_ms) };
      const cur = await q("SELECT holder, token::text AS token, (extract(epoch from expires_at) * 1000)::bigint::text AS expires_ms FROM poa_dice_leases WHERE key = $1", [lk]);
      const row = cur.rows[0] || {};
      return { held: false, holder: row.holder || null, token: Number(row.token || 0), expiresAt: Number(row.expires_ms || 0) };
    },
    /** Shared status row (the bank writer's heartbeat). Fenced like the vault document when a fence is set. */
    async putStatus(name, value) {
      await init();
      const k = `${key}:${name}`;
      if (!fence) {
        await q('INSERT INTO poa_dice_status (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [k, JSON.stringify(value)]);
        return;
      }
      const r = await q(
        'INSERT INTO poa_dice_status (key, value, updated_at) SELECT $1, $2::jsonb, now() WHERE EXISTS (SELECT 1 FROM poa_dice_leases WHERE key = $3 AND holder = $4 AND token = $5 AND expires_at > now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING key',
        [k, JSON.stringify(value), `${key}:${fence.name}`, fence.holder, String(fence.token)]
      );
      if (!r.rows || !r.rows.length) throw new Error('status write fenced off: this instance no longer holds the bank writer lease');
    },
    async getStatus(name) {
      await init();
      const r = await q('SELECT value FROM poa_dice_status WHERE key = $1', [`${key}:${name}`]);
      if (!r.rows[0]) return null;
      const v = r.rows[0].value;
      return typeof v === 'string' ? JSON.parse(v) : v;
    },
    async releaseLease(name, holder) {
      await init();
      await q('UPDATE poa_dice_leases SET expires_at = now() WHERE key = $1 AND holder = $2', [`${key}:${name}`, holder]);
    },
    async claim(claimKey, value) {
      await init();
      const k = `${key}:${claimKey}`;
      const ins = await q('INSERT INTO poa_dice_claims (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING RETURNING value', [k, JSON.stringify(value)]);
      if (ins.rows.length) return { claimed: true, value: JSON.parse(JSON.stringify(value)) };
      const r = await q('SELECT value FROM poa_dice_claims WHERE key = $1', [k]);
      if (!r.rows[0]) throw new Error(`Postgres claim ${claimKey}: conflict but no row`);
      const v = r.rows[0].value;
      return { claimed: false, value: typeof v === 'string' ? JSON.parse(v) : v };
    },
    // One row per scope is locked FOR UPDATE, so concurrent reservations in that scope serialize.
    async reserveCapacity(scope, rkey, micros, limitMicros, ttlMs = 30 * 60 * 1000) {
      await init();
      const sc = `${key}:${scope}`;
      return tx(async (tq) => {
        await tq('INSERT INTO poa_dice_capacity (scope) VALUES ($1) ON CONFLICT (scope) DO NOTHING', [sc]);
        await tq('SELECT scope FROM poa_dice_capacity WHERE scope = $1 FOR UPDATE', [sc]);
        await tq('DELETE FROM poa_dice_reservations WHERE scope = $1 AND expires_at <= now()', [sc]);
        const ex = await tq('SELECT micros FROM poa_dice_reservations WHERE scope = $1 AND key = $2', [sc, rkey]);
        const u = await tq('SELECT COALESCE(SUM(micros), 0)::text AS used FROM poa_dice_reservations WHERE scope = $1', [sc]);
        const used = BigInt(u.rows[0]?.used ?? '0');
        if (ex.rows.length) return { ok: true, usedMicros: used.toString(), existing: true };
        if (used + BigInt(micros) > BigInt(limitMicros)) return { ok: false, usedMicros: used.toString() };
        await tq("INSERT INTO poa_dice_reservations (scope, key, micros, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)", [sc, rkey, String(micros), String(ttlMs)]);
        return { ok: true, usedMicros: (used + BigInt(micros)).toString() };
      });
    },
    async releaseCapacity(scope, rkey, micros = null) {
      await init();
      const sc = `${key}:${scope}`;
      if (micros === null || micros === undefined) {
        await q('DELETE FROM poa_dice_reservations WHERE scope = $1 AND key = $2', [sc, rkey]);
        return;
      }
      await q('UPDATE poa_dice_reservations SET micros = micros - $3 WHERE scope = $1 AND key = $2', [sc, rkey, String(micros)]);
      await q('DELETE FROM poa_dice_reservations WHERE scope = $1 AND key = $2 AND micros <= 0', [sc, rkey]);
    },
    async capacityUsed(scope) {
      await init();
      const u = await q('SELECT COALESCE(SUM(micros), 0)::text AS used FROM poa_dice_reservations WHERE scope = $1 AND expires_at > now()', [`${key}:${scope}`]);
      return String(u.rows[0]?.used ?? '0');
    }
  };
}

/**
 * Pick the vault store for this host.
 *   env.POA_DICE_DATABASE_URL / DATABASE_URL / POSTGRES_URL -> postgres (durable)
 *   env.KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/_TOKEN -> redis (durable)
 *   explicit persistent data dir (POA_DICE_DATA_DIR, or options.dataDirIsPersistent) on a non-Vercel host -> file (durable)
 *   otherwise a writable dir -> file marked durable:false (ephemeral)
 */
export function resolveStore({ env = process.env, dataDir, dataDirIsPersistent = false, keyPrefix = 'poa-dice', bankAddress = 'bank', fetchImpl } = {}) {
  const pgUrl = env.POA_DICE_DATABASE_URL || env.DATABASE_URL || env.POSTGRES_URL;
  if (pgUrl) {
    return createPostgresStore({ connectionString: pgUrl, key: `${env.POA_DICE_KV_KEY || keyPrefix}:${bankAddress}:vault` });
  }
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

/** A store write refused because this instance no longer holds the bank writer lease. */
export function isFencedError(err) {
  return Boolean(err && (err.fenced === true || /fenced off/i.test(String(err.message || ''))));
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
    this.async = store.async === true || store.kind === 'redis' || store.kind === 'postgres';
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
        // Retried by the next save()/flush(), except a write fenced off because this instance lost the
        // writer lease: that snapshot must never land later under a new lease (the next writer starts
        // from the stored document). On 2026-10-27 such a snapshot carried the write-ahead record of a
        // bet that was then refused as "not broadcast" (daba9f3f), and it ended up in the store.
        if (this._pending === null && !isFencedError(err)) this._pending = next;
      }
    });
  }

  /**
   * Forget a snapshot that failed to write and is waiting for its retry. Only for a caller that knows the
   * snapshot must not land (e.g. it carries a record of a submit that was then refused).
   */
  dropPending() {
    this._pending = null;
  }

  /** Atomic insert-if-absent across instances (see adapter docs). Always returns a promise. */
  async claim(key, value) {
    if (typeof this.store.claim !== 'function') return { claimed: true, value, local: true };
    return this.store.claim(key, value);
  }

  /** Atomic cross-instance capacity reservation (see adapter docs). */
  async reserveCapacity(scope, key, micros, limitMicros, ttlMs) {
    if (typeof this.store.reserveCapacity !== 'function') {
      this._localCap = this._localCap || {};
      this._localCap[scope] = this._localCap[scope] || {};
      return capReserve(this._localCap[scope], key, micros, limitMicros, ttlMs ?? 30 * 60 * 1000);
    }
    return this.store.reserveCapacity(scope, key, micros, limitMicros, ttlMs);
  }

  async releaseCapacity(scope, key, micros = null) {
    if (typeof this.store.releaseCapacity !== 'function') {
      if (this._localCap && this._localCap[scope]) capRelease(this._localCap[scope], key, micros);
      return;
    }
    return this.store.releaseCapacity(scope, key, micros);
  }

  async capacityUsed(scope) {
    if (typeof this.store.capacityUsed !== 'function') return capUsed((this._localCap && this._localCap[scope]) || {});
    return BigInt(await this.store.capacityUsed(scope)).toString();
  }

  /** Resolves once every save() so far is durable; rejects if the store is failing. */
  async flush() {
    if (!this.async) return;
    if (this._pending !== null) this._schedule();
    await this._chain;
    if (this._error) throw this._error;
  }
}
