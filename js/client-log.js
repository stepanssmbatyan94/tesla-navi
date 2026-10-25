// Uncaught errors and promise rejections of the car screen and the phone page go to the server
// log (POST /api/client-log): nobody can open the developer tools of the Tesla browser, so this
// is the only way to see a failure that happened in the car. Loaded first on both pages.
(function () {
  const MAX_REPORTS = 20; // per page load: an error repeated in a loop must not flood the server
  const reported = new Set();

  function sendClientLog(entry) {
    const body = JSON.stringify(entry);
    try {
      // sendBeacon survives a page reload/close right after the error
      if (navigator.sendBeacon && navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' }))) return;
    } catch (err) {
      console.warn('client-log beacon failed:', err.message);
    }
    fetch('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
      .catch(err => console.warn('client-log post failed:', err.message));
  }

  function reportClientError(kind, message, source, line, col, stack) {
    if (!message || reported.size >= MAX_REPORTS) return;
    const key = `${kind}|${message}|${source}|${line}`;
    if (reported.has(key)) return;
    reported.add(key);
    sendClientLog({
      kind,
      page: location.pathname.indexOf('/phone') === 0 ? 'phone' : 'car',
      message: String(message).slice(0, 500),
      source: source ? String(source).slice(0, 200) : '',
      line: line || 0,
      col: col || 0,
      stack: stack ? String(stack).slice(0, 2000) : '',
      provider: window.mapEngine ? window.mapEngine.provider : undefined,
      userAgent: navigator.userAgent
    });
  }

  window.addEventListener('error', event => {
    // CDN scripts report only "Script error." without file or line: nothing to act on
    if (!event.filename && event.message === 'Script error.') return;
    reportClientError('error', event.message, event.filename, event.lineno, event.colno, event.error && event.error.stack);
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason);
    reportClientError('rejection', message, '', 0, 0, reason && reason.stack);
  });
})();
