// @ts-nocheck
/**
 * Dismissible notices (public/notice-dismiss.js)
 *
 * A notice with a close (X) button stays closed on reload: the dismissal is stored in
 * localStorage. index.html also reads the same key in <head> so a dismissed notice
 * never flashes before this module runs.
 */

export const LEGAL_NOTICE_KEY = 'poaDice.legalNoticeDismissed';

export function isNoticeDismissed(storage, key = LEGAL_NOTICE_KEY) {
  try {
    return storage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function dismissNotice(storage, key = LEGAL_NOTICE_KEY) {
  try {
    storage?.setItem(key, '1');
    return true;
  } catch {
    return false; // storage blocked: hidden for this page view only
  }
}

/** Wires the close button and hides the notice if it was already dismissed. */
export function initDismissibleNotice({ noticeEl, closeEl, storage, key = LEGAL_NOTICE_KEY, rootEl = null }) {
  if (!noticeEl) return;
  const hide = () => {
    noticeEl.hidden = true;
    rootEl?.setAttribute?.('data-legal-dismissed', '');
  };
  if (isNoticeDismissed(storage, key)) hide();
  closeEl?.addEventListener('click', () => {
    dismissNotice(storage, key);
    hide();
  });
}
