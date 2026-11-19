// Keep a dismissed legal notice hidden before app.js loads (same key as notice-dismiss.js).
try {
  if (localStorage.getItem('poaDice.legalNoticeDismissed') === '1') {
    document.documentElement.setAttribute('data-legal-dismissed', '');
  }
} catch {
  // storage unavailable
}
