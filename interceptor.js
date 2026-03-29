// ============================================================
// Google Drive Transcript Downloader — Fetch Interceptor
// Runs in the PAGE's JS context (world: "MAIN") so it can
// override window.fetch and XMLHttpRequest.
// Fires a CustomEvent on document whenever a timedtext URL
// is detected, which the isolated content script listens for.
// ============================================================

(function () {
  if (window.__gdTranscriptInterceptorInstalled) return;
  window.__gdTranscriptInterceptorInstalled = true;

  const TIMEDTEXT_URL_PATTERN = '/timedtext';
  const TIMEDTEXT_EVENT = '__gd_transcript_timedtext__';

  function notifyContentScript(url) {
    document.dispatchEvent(
      new CustomEvent(TIMEDTEXT_EVENT, { detail: url })
    );
  }

  // --- Override window.fetch ---
  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string'
      ? args[0]
      : (args[0]?.url || '');
    if (url.includes(TIMEDTEXT_URL_PATTERN)) {
      notifyContentScript(url);
    }
    return _origFetch.apply(this, args);
  };

  // --- Override XMLHttpRequest as a fallback ---
  const _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string' && url.includes(TIMEDTEXT_URL_PATTERN)) {
      notifyContentScript(url);
    }
    return _origOpen.call(this, method, url, ...rest);
  };
})();
