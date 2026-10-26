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

function reject(code, reason, extra = {}) {
  return { valid: false, rejected: true, code, reason, error: reason, ...extra };
}

/**
 * Checks a chat post without changing any state.
 * @param {{ text?: string, address?: string, signature?: string, privkey?: string }} args
 * @param {{ recentMessages?: Array<{ signature?: string|null }> }} [ctx]
 */
export function validateSignedChat(args = {}, { recentMessages = [] } = {}) {
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
  if (!verifyRaw(text, signature, address)) {
    return reject('bad_signature', 'signature does not verify for this text and address (sign the exact UTF-8 text with the key of address, Base58-encode the 64-byte signature)');
  }
  if (recentMessages.some((m) => m && m.signature === signature)) {
    return reject('replayed_signature', 'This signed message was already posted. Sign a new message to post again.');
  }
  return { valid: true, text, address, signature };
}

/** Validates and posts. Returns the stored message or a rejection object (never throws for bad input). */
export function postSignedChat(engine, args = {}) {
  const v = validateSignedChat(args, { recentMessages: engine.chatMessages });
  if (!v.valid) return v;
  const name = sanitizeUntrustedText(String(args.sender_name ?? args.senderName ?? ''), CHAT_SENDER_MAX_CHARS);
  const message = engine.postChatMessage({
    address: v.address,
    senderName: name || `Agent-${v.address.slice(4, 10)}`,
    text: v.text,
    isAgent: true,
    signature: v.signature,
    verified: true
  });
  return { ok: true, ...message };
}
