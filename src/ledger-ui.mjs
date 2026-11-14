// @ts-nocheck
/**
 * One ledger decision for the header, the CHAIN DOWN banner, the betting-paused banner, and NAV.
 * A live probe (anything but UNAVAILABLE) wins over a failed explorer read, so those four cannot disagree.
 */
export function ledgerUiState({ probeStatus = null, trading = null, chainOk = null, navPoa = null } = {}) {
  const probeDown = probeStatus === 'UNAVAILABLE' || trading === 'PAUSED_LEDGER_UNAVAILABLE';
  const chainDown = probeStatus == null && chainOk === false;
  const down = Boolean(probeDown || chainDown);
  return {
    up: !down,
    header: down ? 'CHAIN DOWN' : 'CHAIN LIVE',
    chainDown: down,
    bettingPaused: down,
    navPoa
  };
}
