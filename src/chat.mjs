/**
 * Signed chat (src/chat.mjs)
 *
 * The live chat room only accepts messages signed by the poster's own PoA key.
 * The signature is Ed25519 over the exact UTF-8 bytes of `text`, Base58-encoded,
 * and is checked against the public key inside the poa1 address. The server
 * never signs for anyone and never accepts a private key for chat.
 *
 * Used by the MCP tool `chat_send` and by POST /api/chat, so both paths apply
 * exactly the same rules. On-chain `DICE1:CHAT:` memos are signed ledger
 * transfers and are posted by the ledger watcher instead.
 */
import { isValidPoaAddress, sanitizeUntrustedText, verifyRaw } from './crypto-poa.mjs';

export const CHAT_MAX_CHARS = 240;
export const CHAT_SENDER_MAX_CHARS = 32;
export const CHAT_ENVELOPE_PREFIX = 'POA_DICE_CHAT_V2';
export const CHAT_MAX_SKEW_SECONDS = 300;
const SEEN_SIG_LIMIT = 5000;
const seenSignatures = new Map(); // signature -> expiresAtMs

function pruneSeenSignatures(nowMs = Date.now()) {
  if (seenSignatures.size <= SEEN_SIG_LIMIT) return;
  for (const [sig, exp] of seenSignatures) {
    if (exp <= nowMs || seenSignatures.size > SEEN_SIG_LIMIT) seenSignatures.delete(sig);
  }
}

/**
 * Canonical domain-separated v2 payload binding address, senderName, timestamp, nonce, and text.
 */
export function formatChatEnvelope({ address, senderName = '', timestamp, nonce, text }) {
  const cleanName = sanitizeUntrustedText(String(senderName || ''), CHAT_SENDER_MAX_CHARS);
  return `${CHAT_ENVELOPE_PREFIX}\n${String(address || '').trim()}\n${cleanName}\n${Number(timestamp)}\n${String(nonce || '').trim()}\n${text}`;
}
export const formatChatSigningPayloadV2 = formatChatEnvelope;

function reject(code, reason, extra = {}) {
  return { valid: false, rejected: true, code, reason, error: reason, ...extra };
}

/**
 * Checks a chat post without changing any state.
 * Supports both replay-safe v2 envelopes (when timestamp + nonce are supplied, or POA_DICE_CHAT_REQUIRE_V2=1)
 * and legacy raw-text signatures (deduplicated against recentMessages + bounded signature cache).
 * @param {{ text?: string, address?: string, signature?: string, sender_name?: string, senderName?: string, timestamp?: number, nonce?: string, privkey?: string }} args
 * @param {{ recentMessages?: Array<{ signature?: string|null }>, nowSeconds?: number, requireV2?: boolean }} [ctx]
 */
export function validateSignedChat(
  args = {},
  { recentMessages = [], nowSeconds = Math.floor(Date.now() / 1000), requireV2 = process.env.POA_DICE_CHAT_REQUIRE_V2 === '1' } = {}
) {
  if (args.privkey !== undefined && args.privkey !== null && args.privkey !== '') {
    return reject('privkey_refused', 'Chat never takes a private key. Sign the text locally and send address + signature.');
  }
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text.trim()) return reject('empty', 'Message text is empty');
  if (text.length > CHAT_MAX_CHARS) return reject('too_long', `Messages are limited to ${CHAT_MAX_CHARS} characters`);
  const clean = sanitizeUntrustedText(text, CHAT_MAX_CHARS);
  if (clean !== text) {
    return reject(
      'text_not_plain',
      'Text must be plain single-line text: no < or >, no control characters, no leading/trailing or repeated spaces, and nothing the filter rewrites. Sign and send the cleaned text instead.',
      { cleaned_text: clean }
    );
  }
  const address = typeof args.address === 'string' ? args.address.trim() : '';
  if (!address) return reject('missing_address', 'address (your poa1 address) is required');
  if (!isValidPoaAddress(address)) return reject('bad_address', 'address is not a valid poa1 address');
  const signature = typeof args.signature === 'string' ? args.signature.trim() : '';
  if (!signature) return reject('missing_signature', 'signature is required: Base58 Ed25519 signature over the exact text, made with the key of address');

  const senderName = sanitizeUntrustedText(String(args.sender_name ?? args.senderName ?? ''), CHAT_SENDER_MAX_CHARS);
  const hasV2Fields = args.timestamp !== undefined && args.timestamp !== null && args.nonce !== undefined && args.nonce !== null && String(args.nonce).trim() !== '';

  if (requireV2 && !hasV2Fields) {
    return reject('missing_envelope', 'timestamp (unix seconds) and nonce are required for v2 replay-safe chat signing');
  }

  let version = 1;
  if (hasV2Fields) {
    const tsNum = Number(args.timestamp);
    if (!Number.isInteger(tsNum) || Math.abs(nowSeconds - tsNum) > CHAT_MAX_SKEW_SECONDS) {
      return reject('stale_timestamp', `Chat timestamp must be within ±${CHAT_MAX_SKEW_SECONDS}s of server time`);
    }
    const nonce = String(args.nonce).trim();
    if (nonce.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(nonce)) {
      return reject('bad_nonce', 'Chat nonce must be 1–64 alphanumeric/._:- characters');
    }
    const envelope = formatChatEnvelope({ address, senderName, timestamp: tsNum, nonce, text });
    if (!verifyRaw(envelope, signature, address)) {
      return reject('bad_signature', 'signature does not verify for this POA_DICE_CHAT_V2 envelope and address');
    }
    version = 2;
  } else {
    if (!verifyRaw(text, signature, address)) {
      return reject('bad_signature', 'signature does not verify for this text and address (sign the exact UTF-8 text with the key of address, Base58-encode the 64-byte signature)');
    }
  }

  const nowMs = nowSeconds * 1000;
  const seenExp = seenSignatures.get(signature);
  if ((seenExp && seenExp > nowMs) || recentMessages.some((m) => m && m.signature === signature)) {
    return reject('replayed_signature', 'This signed message was already posted. Sign a new message to post again.');
  }

  return { valid: true, version, text, address, signature, senderName };
}

/** Validates and posts. Returns the stored message or a rejection object (never throws for bad input). */
export function postSignedChat(engine, args = {}) {
  const v = validateSignedChat(args, { recentMessages: engine.chatMessages });
  if (!v.valid) return v;
  // Record in bounded TTL cache: 24h for legacy raw signatures, 15m (> 2 * skew) for v2 envelopes
  const ttlMs = v.version === 2 ? (CHAT_MAX_SKEW_SECONDS * 2 + 300) * 1000 : 24 * 60 * 60 * 1000;
  seenSignatures.set(v.signature, Date.now() + ttlMs);
  pruneSeenSignatures();
  const message = engine.postChatMessage({
    address: v.address,
    senderName: v.senderName || `Agent-${v.address.slice(4, 10)}`,
    text: v.text,
    isAgent: true,
    signature: v.signature,
    verified: true
  });
  return { ok: true, envelopeVersion: v.version, ...message };
}

/**
 * Durable multi-instance signed chat post: validates and posts locally, and in chain mode
 * persists the verified message into the shared claim table (`chat:<ts>:<id>`) so posts
 * made on standby instances survive reloads and propagate across all instances.
 */
export async function postSignedChatDurable(engine, args = {}, { settlement = null } = {}) {
  const out = postSignedChat(engine, args);
  if (!out.ok) return out;
  const store = settlement?.store;
  if (store && typeof store.claim === 'function') {
    const key = `chat:${String(out.ts || Math.floor(Date.now() / 1000)).padStart(12, '0')}:${out.id}`;
    try {
      await store.claim(key, {
        id: out.id,
        ts: out.ts,
        address: out.address,
        senderName: out.senderName,
        text: out.text,
        isAgent: Boolean(out.isAgent),
        signature: out.signature,
        verified: true,
        envelopeVersion: out.envelopeVersion
      });
    } catch {
      // non-fatal: local message already posted; next tick retries or remains in local memory
    }
  }
  return out;
}
