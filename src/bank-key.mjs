// @ts-nocheck
/**
 * bank-key.mjs: load the house bank keypair from a server secret.
 *
 * Sources, in order:
 *   1. POA_DICE_BANK_PRIVKEY   Base58 Ed25519 private key (32 bytes)
 *   2. POA_DICE_BANK_KEY_FILE  path to a file holding the Base58 key, or JSON {"privkey": "..."}
 *                              (a minepoa poa.mjs wallet.json works)
 * Optional POA_DICE_BANK_ADDRESS pins the expected poa1 address; a key for any other address is refused.
 *
 * A random bank key is ONLY generated when the caller explicitly allows it (tests / simulated mode).
 * Chain mode never generates one: a missing key makes the server read-only (BANK_KEY_MISSING).
 * The key is never logged, returned in errors, or serialized: the private fields of the
 * returned wallet are non-enumerable, so JSON.stringify(wallet) only shows the address.
 */
import fs from 'node:fs';
import { genKeypair, isValidPoaAddress, walletFromPrivkey } from './crypto-poa.mjs';

export const BANK_KEY_ENV = 'POA_DICE_BANK_PRIVKEY';
export const BANK_KEY_FILE_ENV = 'POA_DICE_BANK_KEY_FILE';
export const BANK_ADDRESS_ENV = 'POA_DICE_BANK_ADDRESS';

function sealWallet(w) {
  const sealed = { address: w.address, pubkey: w.pubkey };
  Object.defineProperty(sealed, 'privkey', { value: w.privkey, enumerable: false });
  Object.defineProperty(sealed, 'privRaw', { value: w.privRaw, enumerable: false });
  Object.defineProperty(sealed, 'pubRaw', { value: w.pubRaw, enumerable: false });
  Object.defineProperty(sealed, 'toJSON', { value: () => ({ address: w.address }), enumerable: false });
  return Object.freeze(sealed);
}

function readKeyFile(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw.startsWith('{')) {
    const j = JSON.parse(raw);
    return String(j.privkey || j.priv || j.secret || '').trim();
  }
  return raw;
}

/**
 * @returns {{ wallet: object|null, status: 'OK'|'EPHEMERAL'|'BANK_KEY_MISSING'|'BANK_KEY_INVALID'|'BANK_ADDRESS_MISMATCH', source: string|null, error: string|null }}
 */
export function loadBankWallet({ env = process.env, allowEphemeral = false, scrubEnv = true } = {}) {
  const expected = String(env[BANK_ADDRESS_ENV] || '').trim();
  let secret = '';
  let source = null;
  try {
    if (env[BANK_KEY_ENV]) {
      secret = String(env[BANK_KEY_ENV]).trim();
      source = 'env';
    } else if (env[BANK_KEY_FILE_ENV]) {
      secret = readKeyFile(String(env[BANK_KEY_FILE_ENV]));
      source = 'file';
    }
  } catch {
    return { wallet: null, status: 'BANK_KEY_INVALID', source: 'file', error: `${BANK_KEY_FILE_ENV} could not be read` };
  } finally {
    // Keep the secret out of child processes and later env dumps.
    if (scrubEnv && env === process.env && env[BANK_KEY_ENV]) delete process.env[BANK_KEY_ENV];
  }

  if (!secret) {
    if (allowEphemeral) {
      return { wallet: sealWallet(genKeypair()), status: 'EPHEMERAL', source: 'ephemeral', error: null };
    }
    return {
      wallet: null,
      status: 'BANK_KEY_MISSING',
      source: null,
      error: `Bank key missing: set ${BANK_KEY_ENV} (or ${BANK_KEY_FILE_ENV}). The server stays read-only until then.`
    };
  }

  let wallet;
  try {
    wallet = walletFromPrivkey(secret);
  } catch {
    return { wallet: null, status: 'BANK_KEY_INVALID', source, error: 'Bank key is not a valid Base58 Ed25519 private key' };
  } finally {
    secret = '';
  }
  if (expected && (!isValidPoaAddress(expected) || expected !== wallet.address)) {
    return {
      wallet: null,
      status: 'BANK_ADDRESS_MISMATCH',
      source,
      error: `Bank key does not match ${BANK_ADDRESS_ENV} (${expected}); refusing to use it`
    };
  }
  return { wallet: sealWallet(wallet), status: 'OK', source, error: null };
}
