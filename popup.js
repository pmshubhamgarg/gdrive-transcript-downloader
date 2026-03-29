// ============================================================
// Google Drive Transcript Downloader — Popup Script
// ============================================================

// ---- State -------------------------------------------------

// Cache the last extraction result so repeated copy/download
// actions don't trigger redundant fetches within the same session
let cachedExtract = null;


// ============================================================
// CHROME API HELPERS
// ============================================================

/** Returns the currently active tab in the focused window */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Sends a message to the content script on the active tab */
async function sendToContent(action, data = {}) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, { action, ...data });
}


// ============================================================
// VIEW MANAGEMENT
// Exactly one view is shown at a time. Each view is a <div>
// with id="view_<name>" in the HTML.
// ============================================================

const VIEWS = ['notDrive', 'notVideo', 'notReady', 'ready', 'error'];

function showView(name) {
  VIEWS.forEach(v => {
    document.getElementById(`view_${v}`).style.display = v === name ? 'block' : 'none';
  });
  hideMessage(); // clear any leftover messages when switching views
}


// ============================================================
// MESSAGE BAR
// ============================================================

function showMessage(text, type) {
  // type: 'info' | 'success' | 'error'
  const box = document.getElementById('msgBox');
  box.textContent = text;
  box.className = `message ${type} show`;
}

function hideMessage() {
  document.getElementById('msgBox').className = 'message';
}


// ============================================================
// BUTTON STATE HELPERS
// ============================================================

function setButtonLoading(btn, label) {
  // Store original HTML so we can restore it later
  btn.dataset.originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span>${label}`;
  btn.disabled = true;
}

function resetButton(btn) {
  btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
  btn.disabled = false;
}


// ============================================================
// STATUS CHECK
// Called on popup open and on every Refresh click.
// Queries the content script for current state and renders
// the appropriate view.
// ============================================================

async function checkStatus() {
  const tab = await getActiveTab();

  // Must be on Google Drive
  if (!tab.url?.includes('drive.google.com')) {
    showView('notDrive');
    return;
  }

  try {
    const status = await sendToContent('checkStatus');

    // If transcript is ready (URL captured OR DOM segments visible),
    // skip isVideoPage check and go straight to the action view.
    if (status.ready) {
      let srcLabel;
      if (status.urlsCaptured > 0) {
        srcLabel = status.urlsCaptured === 1
          ? '1 transcript source captured'
          : `${status.urlsCaptured} transcript sources captured`;
      } else {
        srcLabel = `${status.domSegments} segments visible in transcript panel`;
      }
      document.getElementById('capturedInfo').textContent = srcLabel;
      showView('ready');
      return;
    }

    // No URLs yet — check whether we're even looking at a video
    if (!status.isVideoPage) {
      showView('notVideo');
      return;
    }

    // Video detected but transcript panel hasn't been opened yet
    showView('notReady');

  } catch (e) {
    // Content script not reachable (page not fully loaded, etc.)
    showView('error');
  }
}


// ============================================================
// EXTRACTION HELPER
// Returns cached result if available, otherwise fetches fresh.
// ============================================================

async function extractIfNeeded() {
  if (cachedExtract) return cachedExtract;
  const result = await sendToContent('extractTranscript');
  if (result.success) cachedExtract = result;
  return result;
}


// ============================================================
// BUTTON: Download as .txt (with timestamps)
// ============================================================

document.getElementById('btnDownload').addEventListener('click', async () => {
  const btn = document.getElementById('btnDownload');
  setButtonLoading(btn, 'Extracting…');

  try {
    const result = await extractIfNeeded();

    if (!result.success) {
      showMessage(result.message, 'error');
      return;
    }

    const filename = sanitizeFilename(result.title || 'transcript') + '.txt';
    downloadText(result.withTimestamps, filename);
    showMessage(`Downloaded "${filename}" · ${result.segmentCount} segments`, 'success');

  } catch (e) {
    showMessage('Download failed. Try refreshing.', 'error');
  } finally {
    resetButton(btn);
  }
});


// ============================================================
// BUTTON: Copy with timestamps  ([0:42] Hello world…)
// ============================================================

document.getElementById('btnCopyTimestamps').addEventListener('click', async () => {
  const btn = document.getElementById('btnCopyTimestamps');
  setButtonLoading(btn, 'Copying…');

  try {
    const result = await extractIfNeeded();

    if (!result.success) {
      showMessage(result.message, 'error');
      resetButton(btn);
      return;
    }

    await navigator.clipboard.writeText(result.withTimestamps);
    showMessage(`Copied ${result.segmentCount} segments with timestamps`, 'success');

    // Brief "Copied!" confirmation on the button itself
    btn.innerHTML = '✓ Copied!';
    btn.disabled = false;
    setTimeout(() => resetButton(btn), 2000);

  } catch (e) {
    showMessage('Copy failed.', 'error');
    resetButton(btn);
  }
});


// ============================================================
// BUTTON: Copy plain text  (no timestamps, continuous prose)
// ============================================================

document.getElementById('btnCopyPlain').addEventListener('click', async () => {
  const btn = document.getElementById('btnCopyPlain');
  setButtonLoading(btn, 'Copying…');

  try {
    const result = await extractIfNeeded();

    if (!result.success) {
      showMessage(result.message, 'error');
      resetButton(btn);
      return;
    }

    await navigator.clipboard.writeText(result.plainText);
    showMessage(`Copied plain text · ${result.segmentCount} segments`, 'success');

    btn.innerHTML = '✓ Copied!';
    btn.disabled = false;
    setTimeout(() => resetButton(btn), 2000);

  } catch (e) {
    showMessage('Copy failed.', 'error');
    resetButton(btn);
  }
});


// ============================================================
// BUTTON: Refresh
// Clears the extraction cache so the next action re-fetches,
// then re-runs the status check to update the view.
// ============================================================

document.querySelectorAll('.btn-refresh').forEach(btn => {
  btn.addEventListener('click', () => {
    cachedExtract = null;
    checkStatus();
  });
});


// ============================================================
// HELPERS
// ============================================================

/**
 * Triggers a browser file download for a plain-text string.
 * @param {string} content  - The text to save
 * @param {string} filename - Suggested filename (e.g. "lecture.txt")
 */
function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Strips characters that are illegal in filenames, trims whitespace.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim();
}


// ============================================================
// INIT
// ============================================================

checkStatus();
