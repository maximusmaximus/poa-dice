// @ts-nocheck
/**
 * One ledger decision for the header, the CHAIN DOWN banner, the betting-paused banner, vault holds, and NAV.
 * A live probe (anything but UNAVAILABLE) wins over a failed explorer read, so those four cannot disagree.
 */
const HOLD_STATUSES = new Set([
  'HOLD',
  'READ_ONLY',
  'NO_ACTIVE_LEADER',
  'RECONCILING',
  'SOLVENCY_HOLD',
  'FOREIGN_OUTFLOW_HOLD',
  'LEADER_WAITING',
  'LEADER_WAITING_ON_MINEPOA'
]);

export function ledgerUiState({
  probeStatus = null,
  trading = null,
  chainOk = null,
  navPoa = null,
  hasChain = true,
  readOnly = false,
  reconcileStatus = null
} = {}) {
  const probeDown = probeStatus === 'UNAVAILABLE' || trading === 'PAUSED_LEDGER_UNAVAILABLE';
  const probeLive = probeStatus != null && !probeDown;
  const explorerDown = !probeLive && probeStatus == null && chainOk === false;
  const down = Boolean(probeDown || explorerDown);
  const holdCode =
    !down && (readOnly || (trading && HOLD_STATUSES.has(trading)) || (reconcileStatus && HOLD_STATUSES.has(reconcileStatus)))
      ? readOnly
        ? 'READ_ONLY'
        : trading && HOLD_STATUSES.has(trading)
          ? trading
          : reconcileStatus
      : null;
  const vaultHold = Boolean(holdCode);
  let header;
  if (down) header = 'CHAIN DOWN';
  else if (vaultHold) header = holdCode === 'READ_ONLY' ? 'READ-ONLY' : 'VAULT HOLD';
  else if (hasChain === false) header = 'LIVE';
  else header = 'CHAIN LIVE';
  return {
    up: !down,
    header,
    chainDown: down,
    bettingPaused: down,
    ledgerPaused: Boolean(probeDown),
    probeLive,
    vaultHold,
    holdCode,
    navPoa
  };
}
