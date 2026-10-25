/**
 * crypto-poa.mjs — Proof of Agent (minepoa.com) Ed25519 Cryptography, Canonical JSON Signer,
 * Micro-POA BigInt Math, DICE1:* On-Chain Memo Protocol & Zero-Leak Sanitizer.
 *
 * 100% byte-compatible with https://minepoa.com/client/poa.mjs (POA-SPEC-v0.1).
 * Zero external dependencies (pure Node.js node:crypto).
 */

import crypto from 'node:crypto';

export const MAINNET_CHAIN_ID = 'poa-mainnet-1';
export const MICROS_PER_POA = 1_000_000n;
export const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// ---------------------------------------------------------------------------
// Base58 encoding / decoding (exact match with poa.mjs)
// ---------------------------------------------------------------------------
export function b58enc(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58_ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s || '1';
}

export function b58dec(s) {
  if (typeof s !== 'string' || !s.length) throw new Error('bad base58 string');
  let n = 0n;
  for (const c of s) {
    const i = B58_ALPHABET.indexOf(c);
    if (i < 0) throw new Error('bad base58 char: ' + c);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const buf = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const c of s) {
    if (c === '1') zeros++;
    else break;
  }
  return Buffer.concat([Buffer.alloc(zeros), buf]);
}

// ---------------------------------------------------------------------------
// Ed25519 Keypair & poa1... Address Codec
// ---------------------------------------------------------------------------
const pubKeyObj = (raw) =>
  crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
const privKeyObj = (raw) =>
  crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });

export function genKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(12));
  const privRaw = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16));
  const address = addrOf(pubRaw);
  return {
    pubRaw,
    privRaw,
    address,
    pubkey: b58enc(pubRaw),
    privkey: b58enc(privRaw)
  };
}

export function walletFromPrivkey(privkeyB58) {
  const privRaw = Buffer.isBuffer(privkeyB58) ? privkeyB58 : b58dec(String(privkeyB58).trim());
  if (privRaw.length !== 32) throw new Error('Ed25519 private key must be 32 bytes');
  const privObj = privKeyObj(privRaw);
  const pubObj = crypto.createPublicKey(privObj);
  const pubRaw = Buffer.from(pubObj.export({ type: 'spki', format: 'der' }).subarray(12));
  return {
    pubRaw,
    privRaw,
    address: addrOf(pubRaw),
    pubkey: b58enc(pubRaw),
    privkey: b58enc(privRaw)
  };
}

export const addrOf = (pubRaw) => 'poa1' + b58enc(pubRaw);

export function pubOfAddr(addr) {
  if (!addr || typeof addr !== 'string' || !addr.startsWith('poa1')) {
    throw new Error('bad address: ' + addr);
  }
  const raw = b58dec(addr.slice(4));
  if (raw.length !== 32) throw new Error('bad address length: ' + addr);
  return raw;
}

export function isValidPoaAddress(addr) {
  try {
    pubOfAddr(addr);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON, txid, and Ed25519 Signatures
// ---------------------------------------------------------------------------
export function canonical(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .filter((k) => obj[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(obj);
}

export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function txidOf(body) {
  if (!body || typeof body !== 'object') throw new Error('tx body must be an object');
  const { sig, ...rest } = body;
  return sha256hex(canonical(rest));
}

function resolvePrivRaw(privRawOrB58) {
  if (Buffer.isBuffer(privRawOrB58)) return privRawOrB58;
  if (typeof privRawOrB58 === 'string') return b58dec(privRawOrB58.trim());
  throw new Error('Invalid private key format');
}

export function signBody(body, privRawOrB58) {
  const { sig, ...rest } = body;
  const privRaw = resolvePrivRaw(privRawOrB58);
  return b58enc(crypto.sign(null, Buffer.from(canonical(rest), 'utf8'), privKeyObj(privRaw)));
}

export function verifyBody(body, signerAddr) {
  if (!body || typeof body !== 'object') return false;
  const { sig, ...rest } = body;
  const addr = signerAddr || body.from;
  if (!sig || !addr) return false;
  try {
    const sigBuf = b58dec(sig);
    if (sigBuf.length !== 64) return false;
    return crypto.verify(
      null,
      Buffer.from(canonical(rest), 'utf8'),
      pubKeyObj(pubOfAddr(addr)),
      sigBuf
    );
  } catch {
    return false;
  }
}

export function signRaw(msgUtf8, privRawOrB58) {
  const privRaw = resolvePrivRaw(privRawOrB58);
  return b58enc(crypto.sign(null, Buffer.from(String(msgUtf8), 'utf8'), privKeyObj(privRaw)));
}

export function verifyRaw(msgUtf8, sigB58, signerAddr) {
  if (!sigB58 || !signerAddr) return false;
  try {
    const sigBuf = b58dec(String(sigB58));
    if (sigBuf.length !== 64) return false;
    return crypto.verify(
      null,
      Buffer.from(String(msgUtf8), 'utf8'),
      pubKeyObj(pubOfAddr(signerAddr)),
      sigBuf
    );
  } catch {
    return false;
  }
}

export function buildSignedTransfer({
  wallet,
  to,
  amount,
  memo = '',
  nonce = 1,
  parents = [],
  ts = Math.floor(Date.now() / 1000),
  cid = MAINNET_CHAIN_ID
}) {
  if (!wallet || !wallet.address || (!wallet.privkey && !wallet.privRaw)) {
    throw new Error('Wallet with address and privkey required to sign transfer');
  }
  if (!isValidPoaAddress(to)) {
    throw new Error(`Invalid recipient POA address: ${to}`);
  }
  const amountMicros = toMicros(amount);
  if (amountMicros <= 0n) {
    throw new Error('Transfer amount must be positive');
  }
  const body = {
    type: 'transfer',
    from: wallet.address,
    to,
    amount: fromMicros(amountMicros),
    memo: String(memo ?? '').slice(0, 500),
    nonce: Number(nonce),
    parents: Array.isArray(parents) ? parents.slice(-2) : [],
    ts: Number(ts),
    cid: String(cid || MAINNET_CHAIN_ID)
  };
  body.sig = signBody(body, wallet.privRaw || wallet.privkey);
  return {
    id: txidOf(body),
    kind: 'tx',
    body
  };
}

// ---------------------------------------------------------------------------
// Exact Micro-POA Conversion (6 decimals, BigInt only, zero float drift)
// ---------------------------------------------------------------------------
export function toMicros(val) {
  if (typeof val === 'bigint') {
    if (val < 0n) throw new Error('Negative micro-POA amount not allowed');
    return val;
  }
  const s = String(val ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) {
    throw new Error(`Invalid POA amount "${val}" (expected positive decimal with up to 6 decimals)`);
  }
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole) * MICROS_PER_POA + BigInt(fracPadded);
}

export function fromMicros(micros) {
  const m = BigInt(micros);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / MICROS_PER_POA;
  const frac = (abs % MICROS_PER_POA).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${frac}`;
}

// ---------------------------------------------------------------------------
// DICE1:* On-Chain Memo Protocol Codec (Website-Down / Pure Ledger Mode)
// ---------------------------------------------------------------------------
/**
 * Supported On-Chain Memos sent to BANK_ADDRESS:
 *   1. DICE1:BET:<under|over>:<targetBps>:<clientSeed>
 *      e.g. "DICE1:BET:under:4950:agent-seed-99"
 *   2. DICE1:LP_ADD[:epochs=<N>][:ref=<poa1...>]
 *      e.g. "DICE1:LP_ADD:epochs=4:ref=poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U"
 *   3. DICE1:LP_WITHDRAW:<shares|ALL|BPS=<1..10000>>
 *      e.g. "DICE1:LP_WITHDRAW:ALL" or "DICE1:LP_WITHDRAW:BPS=5000" or "DICE1:LP_WITHDRAW:1000000000000"
 *   4. DICE1:CHAT:<message>
 *   5. DICE1:CLAIM
 */
export function parseDiceMemo(memoStr) {
  const raw = String(memoStr ?? '').trim();
  if (!raw.startsWith('DICE1:')) {
    return { valid: false, reason: 'not_dice_memo', raw };
  }
  const parts = raw.split(':');
  const action = (parts[1] || '').toUpperCase();

  if (action === 'BET') {
    const direction = (parts[2] || '').toLowerCase();
    const targetRaw = parts[3] || '';
    const clientSeed = sanitizeUntrustedText(parts.slice(4).join(':') || 'default', 64);
    if (direction !== 'under' && direction !== 'over') {
      return { valid: false, action: 'BET', reason: 'invalid_direction (must be under or over)' };
    }
    let targetBps;
    if (/^\d+\.\d{1,2}$/.test(targetRaw)) {
      targetBps = Math.round(parseFloat(targetRaw) * 100);
    } else if (/^\d+$/.test(targetRaw)) {
      const n = parseInt(targetRaw, 10);
      // Support both 1..98 integer percent and 100..9899 bps
      targetBps = n < 100 ? n * 100 : n;
    } else {
      return { valid: false, action: 'BET', reason: 'invalid_target_bps' };
    }
    return {
      valid: true,
      action: 'BET',
      direction,
      targetBps,
      clientSeed: clientSeed || 'default'
    };
  }

  if (action === 'LP_ADD' || action === 'STAKE') {
    let lockEpochs = 0;
    let referrer = null;
    for (const kv of parts.slice(2)) {
      if (kv.startsWith('epochs=')) {
        const e = parseInt(kv.slice(7), 10);
        if (Number.isInteger(e) && e >= 0 && e <= 1000) lockEpochs = e;
      } else if (kv.startsWith('ref=')) {
        const r = kv.slice(4).trim();
        if (isValidPoaAddress(r)) referrer = r;
      }
    }
    return {
      valid: true,
      action: 'LP_ADD',
      lockEpochs,
      referrer
    };
  }

  if (action === 'LP_WITHDRAW' || action === 'UNSTAKE') {
    const spec = (parts[2] || 'ALL').trim();
    if (spec.toUpperCase() === 'ALL') {
      return { valid: true, action: 'LP_WITHDRAW', mode: 'ALL', shares: null, bps: 10000 };
    }
    if (spec.toUpperCase().startsWith('BPS=')) {
      const bps = parseInt(spec.slice(4), 10);
      if (!Number.isInteger(bps) || bps < 1 || bps > 10000) {
        return { valid: false, action: 'LP_WITHDRAW', reason: 'invalid_withdraw_bps' };
      }
      return { valid: true, action: 'LP_WITHDRAW', mode: 'BPS', shares: null, bps };
    }
    if (/^\d+$/.test(spec)) {
      return { valid: true, action: 'LP_WITHDRAW', mode: 'SHARES', shares: BigInt(spec), bps: null };
    }
    return { valid: false, action: 'LP_WITHDRAW', reason: 'invalid_withdraw_spec' };
  }

  if (action === 'CHAT') {
    const text = sanitizeUntrustedText(parts.slice(2).join(':'), 280);
    if (!text) return { valid: false, action: 'CHAT', reason: 'empty_chat_message' };
    return { valid: true, action: 'CHAT', text };
  }

  if (action === 'CLAIM') {
    return { valid: true, action: 'CLAIM' };
  }

  return { valid: false, action, reason: `unknown_action:${action}` };
}

export function formatDiceMemo(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Memo spec required');
  const act = String(spec.action || '').toUpperCase();
  if (act === 'BET') {
    const dir = spec.direction === 'over' ? 'over' : 'under';
    const targetBps = Number(spec.targetBps);
    const seed = String(spec.clientSeed || 'default').replace(/[:\r\n]/g, '_').slice(0, 64);
    return `DICE1:BET:${dir}:${targetBps}:${seed}`;
  }
  if (act === 'LP_ADD') {
    const extras = [];
    if (spec.lockEpochs && Number(spec.lockEpochs) > 0) extras.push(`epochs=${Number(spec.lockEpochs)}`);
    if (spec.referrer && isValidPoaAddress(spec.referrer)) extras.push(`ref=${spec.referrer}`);
    return ['DICE1:LP_ADD', ...extras].join(':');
  }
  if (act === 'LP_WITHDRAW') {
    if (spec.shares) return `DICE1:LP_WITHDRAW:${spec.shares.toString()}`;
    if (spec.bps && Number(spec.bps) < 10000) return `DICE1:LP_WITHDRAW:BPS=${Number(spec.bps)}`;
    return 'DICE1:LP_WITHDRAW:ALL';
  }
  if (act === 'CHAT') {
    return `DICE1:CHAT:${sanitizeUntrustedText(spec.text || '', 240)}`;
  }
  if (act === 'CLAIM') {
    return 'DICE1:CLAIM';
  }
  throw new Error(`Unsupported memo action: ${act}`);
}

// ---------------------------------------------------------------------------
// Zero-Leak Secret Redaction & Anti-Prompt-Injection Sanitizer
// ---------------------------------------------------------------------------
const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above|system)\s*(instructions|prompts|rules)?\b/gi,
  /\bsystem\s*prompt\b/gi,
  /\bSYSTEM_NOTICE\b/gi,
  /\b(?:send|transfer)\s+(?:all\s+)?(?:poa|funds|balance)\s+to\b/gi,
  /\b(?:reveal|print|echo|export)\s+(?:your\s+)?(?:api[_\s-]?key|private\s*key|privkey|\.poa\/key)\b/gi
];

export function redactSecrets(text, extraSecret = '') {
  if (!text) return '';
  let out = String(text);
  if (extraSecret && extraSecret.length >= 8) {
    out = out.split(extraSecret).join('[REDACTED]');
  }
  out = out.replace(/\bpk_[A-Za-z0-9_-]{8,}\b/g, 'pk_[REDACTED]');
  out = out.replace(/\bpsk_[A-Za-z0-9_-]{8,}\b/g, 'psk_[REDACTED]');
  return out;
}

export function sanitizeUntrustedText(text, maxLen = 280) {
  if (!text) return '';
  let out = redactSecrets(String(text));
  // Strip control characters and HTML angle brackets
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
  out = out.replace(/[<>]/g, '');
  for (const pat of INJECTION_PATTERNS) {
    out = out.replace(pat, '[FILTERED_INJECTION]');
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
