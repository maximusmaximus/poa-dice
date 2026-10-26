// @ts-nocheck
/**
 * bank-writer.mjs: decides whether THIS server instance may roll bets, book settlement and sign with the
 * bank key. Fail-closed: every answer other than "yes" means read-only.
 *
 * An instance is the bank writer only when ALL of these hold:
 *   1. POA_DICE_BANK_SIGNER=1 is set (default off).
 *   2. The vault store supports leases (Postgres; a file store on a persistent disk; memory in tests).
 *      Redis has no lease support, so a Redis-backed vault never signs.
 *   3. The store carries a binding record for this bank (claim key `store-binding`). A binding is created
 *      once, explicitly (POA_DICE_BIND_STORE=<bank address> or POST /api/admin/store-binding), and only
 *      when the store is provably the live one (see ChainSettlement.bindStore). An empty or different store
 *      (for example a preview deployment that inherited the bank key) has no binding and stays read-only.
 *      If POA_DICE_STORE_ID is set, the binding's storeId must equal it.
 *   4. The instance holds the single-writer lease in that store (`bank-writer`), renewed every tick.
 *      The lease carries a fencing token; on Postgres every vault write is fenced by it, and every payout
 *      claim records it.
 *   5. On taking the lease, the stored vault document accounts for every bank outflow on the ledger
 *      (ChainSettlement checks this). A copy of the database (for example a branch made for a preview)
 *      misses the outflows made after the copy and stays read-only (STALE_STORE).
 *   6. Not a Vercel preview/development deployment (VERCEL_ENV other than "production" is always read-only).
 */
import crypto from 'node:crypto';

export const WRITER_LEASE = 'bank-writer';
export const BINDING_KEY = 'store-binding';

export const WRITER_REASONS = {
  DISABLED: 'Bank signing is off on this instance (POA_DICE_BANK_SIGNER is not 1). Read-only: no bets are rolled and nothing is signed.',
  UNSUPPORTED_STORE: 'The vault store has no single-writer lease (Redis or an ephemeral file). Read-only: bank signing needs the shared Postgres store.',
  UNBOUND: 'This vault store is not bound to the bank yet. Read-only until the one-time binding step (POA_DICE_BIND_STORE or POST /api/admin/store-binding) succeeds.',
  BINDING_MISMATCH: 'This vault store is bound to a different bank or store id. Read-only.',
  STANDBY: 'Another server instance holds the bank writer lease. This one is a read-only standby.',
  STORE_ERROR: 'The vault store could not be reached to confirm the bank writer lease. Read-only until it answers.',
  STALE_STORE: 'The stored vault does not account for every bank transfer on the ledger (an old copy of the store, or a transfer made outside this vault). Read-only until an operator reviews it (POST /api/admin/store-binding with recovery: true).',
  NOT_PRODUCTION: 'This is not a production deployment (VERCEL_ENV is not "production"). Read-only: previews never sign with the bank key.'
};

export class BankWriter {
  constructor({ store, bankAddress, enabled = false, expectedStoreId = null, leaseMs = 30000, holderId = null, now = () => Date.now(), deploymentEnv = null } = {}) {
    this.store = store;
    this.bankAddress = bankAddress;
    this.enabled = Boolean(enabled);
    this.deploymentEnv = deploymentEnv || null; // VERCEL_ENV when present
    this.blocked = null; // {reason, outflows}: set when the stored vault is stale on takeover
    this.expectedStoreId = expectedStoreId || null;
    this.leaseMs = leaseMs;
    this.holderId = holderId || `w-${crypto.randomBytes(8).toString('hex')}`;
    this.now = now;
    this.status = this.enabled ? 'UNBOUND' : 'DISABLED';
    this.binding = null;
    this.lease = null; // {held, holder, token, expiresAt}
    this.tokenAtTickStart = null;
    this.lastError = null;
    // Until this instance proves it is the writer, nothing it saves may land (Postgres fencing).
    if (typeof this.store?.setFence === 'function') this.store.setFence({ name: WRITER_LEASE, holder: this.holderId, token: -1 });
  }

  supportsLease() {
    return Boolean(this.store && typeof this.store.lease === 'function' && typeof this.store.peek === 'function' && this.store.durable !== false);
  }

  /** Re-check the flag, the binding and the lease. Returns true when this instance may write. */
  async refresh() {
    if (!this.enabled) return this._set('DISABLED');
    if (this.deploymentEnv && this.deploymentEnv !== 'production') return this._set('NOT_PRODUCTION');
    if (!this.supportsLease()) return this._set('UNSUPPORTED_STORE');
    try {
      if (!this.binding) this.binding = (await this.store.peek(BINDING_KEY)) || null;
      if (!this.binding) return this._set('UNBOUND');
      if (this.binding.bankAddress !== this.bankAddress || (this.expectedStoreId && this.binding.storeId !== this.expectedStoreId)) return this._set('BINDING_MISMATCH');
      if (this.blocked) return this._set('STALE_STORE');
      const prev = this.lease;
      this.lease = await this.store.lease(WRITER_LEASE, this.holderId, this.leaseMs);
      if (!this.lease.held) return this._set('STANDBY');
      if (typeof this.store.setFence === 'function' && (!prev || prev.token !== this.lease.token)) this.store.setFence({ name: WRITER_LEASE, holder: this.holderId, token: this.lease.token });
      this.lastError = null;
      return this._set('LEADER');
    } catch (err) {
      this.lastError = String(err.message || err);
      this.lease = null;
      return this._set('STORE_ERROR');
    }
  }

  _set(status) {
    this.status = status;
    if (status !== 'LEADER' && typeof this.store?.setFence === 'function') this.store.setFence({ name: WRITER_LEASE, holder: this.holderId, token: -1 }); // nothing lands
    return status === 'LEADER';
  }

  /** True while the lease is held and not about to expire. */
  canWrite() {
    return this.status === 'LEADER' && Boolean(this.lease?.held) && this.lease.expiresAt - this.now() > Math.min(5000, this.leaseMs / 3);
  }

  /** Renew right before signing; refuses when the lease changed hands since the tick started. */
  async assertLeader() {
    const before = this.lease?.token ?? null;
    const ok = await this.refresh();
    if (!ok) throw new Error(WRITER_REASONS[this.status] || 'not the bank writer');
    if (this.tokenAtTickStart !== null && this.lease.token !== this.tokenAtTickStart) throw new Error('bank writer lease changed hands during this tick');
    if (before !== null && before !== this.lease.token) throw new Error('bank writer lease changed hands');
    return this.lease.token;
  }

  hold() {
    if (this.status === 'LEADER') return null;
    return { status: 'SIGNER_READ_ONLY', reason: WRITER_REASONS[this.status] || 'Read-only', writer: this.status };
  }

  /** The stored vault is stale: give up the lease and stay read-only until an operator clears it. */
  async block(reason, outflows = []) {
    this.blocked = { reason, outflows, at: new Date(this.now()).toISOString() };
    await this.release();
    this._set('STALE_STORE');
  }

  unblock() {
    this.blocked = null;
  }

  async release() {
    if (this.lease?.held && typeof this.store?.releaseLease === 'function') {
      try {
        await this.store.releaseLease(WRITER_LEASE, this.holderId);
      } catch {
        // ignore
      }
    }
    this.lease = null;
    this._set(!this.enabled ? 'DISABLED' : this.blocked ? 'STALE_STORE' : 'STANDBY');
  }

  view() {
    return {
      role: this.status === 'LEADER' ? 'writer' : 'read-only',
      status: this.status,
      reason: this.status === 'LEADER' ? null : WRITER_REASONS[this.status] || null,
      signerEnabled: this.enabled,
      storeKind: this.store?.kind || null,
      binding: this.binding ? { bankAddress: this.binding.bankAddress, storeId: this.binding.storeId, boundAt: this.binding.boundAt, via: this.binding.via, recovery: Boolean(this.binding.recovery) } : null,
      lease: this.lease ? { held: this.lease.held, token: this.lease.token, expiresAt: this.lease.expiresAt ? new Date(this.lease.expiresAt).toISOString() : null, holderIsMe: this.lease.holder === this.holderId } : null,
      blocked: this.blocked,
      lastError: this.lastError
    };
  }
}
