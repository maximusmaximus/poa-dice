// @ts-nocheck
/**
 * settlement-store.mjs: durable JSON document store for the settlement queue.
 *
 * File adapter: atomic write (tmp + fsync + rename) into POA_DICE_DATA_DIR. It needs a persistent
 * disk. Serverless hosts (e.g. Vercel functions) have an ephemeral filesystem and memory, so there
 * you must plug in a KV/DB adapter with the same two methods:
 *   load(): object|null        save(doc: object): void (must be durable before returning)
 * The memory adapter exists for tests only.
 */
import fs from 'node:fs';
import path from 'node:path';

export function createFileStore(dir, name = 'settlement.json') {
  const file = path.join(dir, name);
  return {
    kind: 'file',
    location: file,
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
