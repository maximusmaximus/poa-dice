// @ts-nocheck
/**
 * Re-export browser-safe ledger UI state helper from public/ledger-ui.js
 * so server, tests, and browser share one exact module inside public/.
 */
export { ledgerUiState } from '../public/ledger-ui.js';
