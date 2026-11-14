// @ts-nocheck
/**
 * chain-settlement.mjs — Thin facade composing the modularized settlement subsystems:
 *   - settlement/constants.mjs
 *   - settlement/vault-persistence.mjs
 *   - settlement/coverage-manager.mjs
 *   - settlement/ledger-scanner.mjs
 *   - settlement/inbound-processor.mjs
 *   - settlement/outbound-dispatcher.mjs
 *   - settlement/leader-coordinator.mjs
 *   - settlement/reconciler-and-repay.mjs
 */
import { BankWriter } from './bank-writer.mjs';
import { PersistQueue } from './settlement-store.mjs';
import { MINEPOA_ADDRESS_CAP } from './bank-history.mjs';
import {
  LEADER_STATUS_KEY,
  LEADER_WAITING,
  NO_ACTIVE_LEADER,
  WRITER_LEASE_RENEWING_REASON,
  now,
  parseExpectedNonce,
  tradingLabel
} from './settlement/constants.mjs';
import { vaultPersistenceMethods } from './settlement/vault-persistence.mjs';
import { coverageManagerMethods } from './settlement/coverage-manager.mjs';
import { ledgerScannerMethods } from './settlement/ledger-scanner.mjs';
import { inboundProcessorMethods } from './settlement/inbound-processor.mjs';
import { outboundDispatcherMethods } from './settlement/outbound-dispatcher.mjs';
import { docKnownIds, leaderCoordinatorMethods } from './settlement/leader-coordinator.mjs';
import { reconcilerAndRepayMethods, repayMemo } from './settlement/reconciler-and-repay.mjs';

export {
  LEADER_STATUS_KEY,
  NO_ACTIVE_LEADER,
  LEADER_WAITING,
  WRITER_LEASE_RENEWING_REASON,
  tradingLabel,
  parseExpectedNonce
};

export class ChainSettlement {
  static docKnownIds = docKnownIds;
  static repayMemo = repayMemo;

  constructor({
    engine,
    watcher,
    client,
    bankWallet,
    store,
    confirmPolicy = 'final',
    backoffBaseMs = 2000,
    backoffMaxMs = 5 * 60 * 1000,
    maxResign = 3,
    inboundExpireMs = 30 * 60 * 1000,
    balanceStaleMs = 60 * 1000,
    ledgerProbe = null,
    rejectConfirmations = 3,
    rejectCheckIntervalMs = 15000,
    sentGraceMs = 20000,
    stuckAfterMs = 10 * 60 * 1000,
    nonceScanDepth = 12,
    writer = null,
    bindOnBoot = false,
    onLoadStateChange = null,
    onRemoteEvent = null,
    loadRetryBaseMs = 2000,
    loadRetryMaxMs = 60000,
    leaderStatusMaxAgeMs = 90000,
    passMode = false,
    passEveryMs = 15000,
    rebroadcastAfterMs = 60000,
    payoutRetryMaxMs = 30000,
    trustedBalanceMaxAgeMs = 10 * 60 * 1000,
    indexer = null,
    addressListCap = MINEPOA_ADDRESS_CAP,
    historyBackfillEveryMs = 2 * 60 * 1000,
    takeoverBackoffBaseMs = 2000,
    takeoverBackoffMaxMs = 2 * 60 * 1000,
    maxHotInbound = 2000,
    maxHotOutbound = 2000,
    maxBankHistoryRecent = 2000,
    compactAgeMs = 15 * 60 * 1000,
    random = Math.random,
    logger = null
  }) {
    if (!bankWallet || !bankWallet.address) throw new Error('ChainSettlement needs the bank wallet');
    this.engine = engine;
    this.watcher = watcher;
    this.client = client;
    this.indexer = indexer;
    this.addressListCap = addressListCap;
    this.historyBackfillEveryMs = historyBackfillEveryMs;
    this._historyBackfill = { at: 0, okAt: null, reason: null, added: 0 };
    this._historyStatus = null;
    Object.defineProperty(this, 'bankWallet', { value: bankWallet, enumerable: false });
    this.bankAddress = bankWallet.address;
    this.store = store;
    this.confirmPolicy = confirmPolicy;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.maxResign = maxResign;
    this.rejectConfirmations = Math.max(1, rejectConfirmations);
    this.rejectCheckIntervalMs = rejectCheckIntervalMs;
    this.sentGraceMs = sentGraceMs;
    this.stuckAfterMs = stuckAfterMs;
    this.nonceScanDepth = nonceScanDepth;
    this._txNonce = new Map();
    this.writer = writer || new BankWriter({ store, bankAddress: bankWallet.address, enabled: false });
    this.bindOnBoot = Boolean(bindOnBoot);
    this._leaderToken = null;
    this.foreign = [];
    this._ordVerdict = new Map();
    this._takeoverMatches = [];
    this.leaderStatusMaxAgeMs = leaderStatusMaxAgeMs;
    this.passMode = Boolean(passMode);
    this.passEveryMs = passEveryMs;
    this.rebroadcastAfterMs = rebroadcastAfterMs;
    this.payoutRetryMaxMs = payoutRetryMaxMs;
    this.trustedBalanceMaxAgeMs = trustedBalanceMaxAgeMs;
    this._lastPass = null;
    this.takeoverBackoffBaseMs = takeoverBackoffBaseMs;
    this.takeoverBackoffMaxMs = takeoverBackoffMaxMs;
    this.maxHotInbound = maxHotInbound;
    this.maxHotOutbound = maxHotOutbound;
    this.maxBankHistoryRecent = maxBankHistoryRecent;
    this.compactAgeMs = compactAgeMs;
    this._random = random;
    this._takeoverWait = null;
    this._waitBase = null;
    this._takeoverErr = null;
    this.writer.onBeat = () => this._onWriterBeat();
    this._observePromise = null;
    this.passes = { started: 0, completed: 0, lastStartedAt: null, lastCompletedAt: null, lastMs: null };
    this.shared = null;
    this._sharedReadAt = 0;
    this._replicaSavedAt = null;
    this._replicaAt = 0;
    this._standbyLocal = new Map();
    this._groupClaims = new Map();
    this.inboundExpireMs = inboundExpireMs;
    this.balanceStaleMs = balanceStaleMs;
    this._lastRow = null;
    this._lastRowAt = 0;
    this.logger = logger;
    this.onRemoteEvent = onRemoteEvent;
    this.ledgerProbe = ledgerProbe;
    if (ledgerProbe && !ledgerProbe.onChange) ledgerProbe.onChange = (view) => this._emit('ledger.status', view);
    this._tickPromise = null;
    this._tickErrors = [];
    this._timer = null;
    this._nonceCache = new Map();
    this._outboundBySource = new Map();
    this._outboundIndexedRef = null;
    this._outboundIndexedLen = 0;
    this._playTimeCache = null;
    this.lastTick = null;
    this.lastError = null;
    this.lastBankBalance = null;

    this._persist = new PersistQueue(store);
    this._loaded = false;
    this.fatalError = null;
    this.ledgerIndexComplete = false;
    this.reconcile = {
      status: 'PENDING',
      reason: 'Reconciling the vault with the minepoa ledger (first pass not finished yet)',
      at: null,
      inReview: [],
      recovered: 0,
      audit: null
    };
    this.state = {
      version: 1,
      bankAddress: this.bankAddress,
      bankNonce: null,
      inbound: {},
      outbound: {},
      groups: {},
      ledgerOut: {},
      seq: 0,
      createdAt: Math.floor(now() / 1000)
    };
    this.onLoadStateChange = onLoadStateChange;
    this.loadRetryBaseMs = loadRetryBaseMs;
    this.loadRetryMaxMs = loadRetryMaxMs;
    this.vaultLoad = {
      status: 'LOADING',
      attempts: 0,
      failures: 0,
      lastError: null,
      lastErrorAt: null,
      nextRetryAt: null,
      loadedAt: null,
      phases: []
    };
    let loaded;
    const startedAt = Date.now();
    try {
      loaded = store.load();
    } catch (err) {
      loaded = Promise.reject(err);
    }
    if (loaded && typeof loaded.then === 'function') {
      this._loadPromise = this._trackLoad(loaded, startedAt);
    } else {
      this.vaultLoad.attempts = 1;
      try {
        this._applyDoc(loaded);
        this._captureLoadPhases(startedAt);
        this._markLoaded();
      } catch (err) {
        this._captureLoadPhases(startedAt, err);
        throw err;
      }
      this._loadPromise = Promise.resolve();
    }
  }
}

Object.assign(
  ChainSettlement.prototype,
  vaultPersistenceMethods,
  coverageManagerMethods,
  ledgerScannerMethods,
  inboundProcessorMethods,
  outboundDispatcherMethods,
  leaderCoordinatorMethods,
  reconcilerAndRepayMethods
);
