// ============================================================
// Google Drive Transcript Downloader — Content Script
// Injected automatically into all drive.google.com pages.
// Intercepts the timedtext network request made by Drive's
// video player, then parses the raw json3 response on demand.
// ============================================================

// ---- Constants ---------------------------------------------

// Substring present in every Google Drive timedtext request URL
const TIMEDTEXT_URL_PATTERN = '/timedtext';

// aria-label prefix on every transcript segment DOM node —
// used as a reliable fallback when the network URL wasn't captured
const SEGMENT_ARIA_PREFIX = 'Segment starting at';

// CustomEvent name — must match the one fired by interceptor.js
const TIMEDTEXT_EVENT = '__gd_transcript_timedtext__';

// Video file extensions used to detect a video page
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];


// ---- State -------------------------------------------------

// Stores every unique timedtext URL captured during this session.
// A Set naturally deduplicates if the same URL fires twice
// (e.g. user closes and reopens the transcript panel).
const capturedUrls = new Set();


// ---- Listen for captured URLs from page context ------------
// interceptor.js (world: "MAIN") overrides fetch/XHR and fires
// this CustomEvent whenever a timedtext URL is detected.

document.addEventListener(TIMEDTEXT_EVENT, (e) => {
  if (e.detail) {
    const isNew = !capturedUrls.has(e.detail);
    capturedUrls.add(e.detail);
    if (isNew) {
      console.debug('[GD Transcript] Captured timedtext URL:', e.detail);
    }
  }
});


// ============================================================
// MESSAGE HANDLER  (popup → content script)
// ============================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {

    // --- checkStatus: called when popup opens or refreshes ---
    case 'checkStatus': {
      const domSegments = document.querySelectorAll(`[aria-label^="${SEGMENT_ARIA_PREFIX}"]`).length;
      sendResponse({
        isVideoPage: isVideoPage(),
        urlsCaptured: capturedUrls.size,
        domSegments,
        // Ready if we have a network URL OR segments are visible in the DOM
        ready: capturedUrls.size > 0 || domSegments > 0
      });
      break;
    }

    // --- extractTranscript: fetch + parse all captured URLs ---
    case 'extractTranscript': {
      extractTranscript()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({
          success: false,
          message: `Extraction error: ${err.message}`
        }));
      return true; // keep channel open for async response
    }

    default:
      break;
  }

  return true;
});


// VIDEO PAGE DETECTION
//
// Drive videos often open as an overlay on a folder page, so:
//   - document.title stays as the folder name (no .mp4)
//   - <video> may be inside a cross-origin iframe (unreachable)
// We cast a wide net using several independent signals.
// ============================================================

function isVideoPage() {
  // 1. Direct <video> element in the document
  if (document.querySelector('video') !== null) return true;

  // 2. Drive's video viewer overlay elements
  if (document.querySelector('[data-type="video"]') !== null) return true;

  // 3. Transcript sidebar or button present → definitely a video context
  if (document.querySelector('[aria-label="Transcript sidebar"]') !== null) return true;
  if (document.querySelector('[aria-label*="Transcript" i]') !== null) return true;

  // 4. Document title contains a video file extension
  const title = document.title.toLowerCase();
  if (VIDEO_EXTENSIONS.some(ext => title.includes(ext))) return true;

  // 5. The file viewer URL pattern (drive.google.com/file/d/...)
  if (window.location.pathname.includes('/file/d/')) return true;

  return false;
}


// ============================================================
// TRANSCRIPT EXTRACTION
// Fetches every captured timedtext URL, merges their events,
// sorts by timestamp, and returns two formats:
//   withTimestamps — "[0:42] Hello world"
//   plainText      — "Hello world ..."
// ============================================================

async function extractTranscript() {
  // Prefer the network URL (full json3 data, most reliable)
  if (capturedUrls.size > 0) {
    try {
      const allEvents = [];

      for (const url of capturedUrls) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        allEvents.push(...(data.events || []));
      }

      allEvents.sort((a, b) => (a.tStartMs || 0) - (b.tStartMs || 0));
      const result = parseJson3Events(allEvents);

      // If network parse succeeded, return it
      if (result.success) return result;

      // Otherwise fall through to DOM fallback
      console.warn('[GD Transcript] json3 parse empty, trying DOM fallback');
    } catch (err) {
      console.warn('[GD Transcript] Network fetch failed, trying DOM fallback:', err.message);
    }
  }

  // Fallback: scrape segments from the transcript sidebar DOM.
  // Uses aria-label which is accessibility-facing and more stable than jsname.
  return extractFromDOM();
}

/**
 * DOM-based extraction — reads aria-label on each visible transcript segment.
 * Format: "Segment starting at 0:42, Hello world"
 */
function extractFromDOM() {
  const segments = document.querySelectorAll(`[aria-label^="${SEGMENT_ARIA_PREFIX}"]`);

  if (segments.length === 0) {
    return {
      success: false,
      message: 'No transcript segments found. Make sure the transcript panel is open and has loaded.'
    };
  }

  const withTimestamps = [];
  const plainLines = [];

  segments.forEach(seg => {
    const label = seg.getAttribute('aria-label') || '';
    // Expected format: "Segment starting at 9:42, Some spoken text here"
    const match = label.match(/Segment starting at ([\d:]+),\s*(.+)/);
    if (match) {
      const timestamp = match[1].trim();
      const text = match[2].trim();
      withTimestamps.push(`[${timestamp}] ${text}`);
      plainLines.push(text);
    }
  });

  if (withTimestamps.length === 0) {
    return { success: false, message: 'Could not parse any transcript segments from the page.' };
  }

  const videoTitle = document.title.replace(/\s*-\s*Google Drive\s*$/i, '').trim();

  return {
    success: true,
    withTimestamps: withTimestamps.join('\n'),
    plainText: plainLines.join(' '),
    title: videoTitle,
    segmentCount: withTimestamps.length,
    message: `Extracted ${withTimestamps.length} segments (via DOM fallback)`
  };
}


// ============================================================
// JSON3 PARSER
//
// Google's json3 caption format uses "events", where each event
// represents a caption cue. Key fields:
//   tStartMs   — cue start time in milliseconds
//   segs       — array of text pieces { utf8, tOffsetMs }
//   aAppend:1  — "append" event (usually just a newline marker
//                between rolling captions) — we skip these
// ============================================================

function parseJson3Events(events) {
  const withTimestamps = [];
  const plainLines = [];

  for (const event of events) {
    // Skip append/newline events — they carry no new caption text
    if (!event.segs || event.aAppend) continue;

    const text = event.segs
      .map(seg => seg.utf8 || '')
      .join('')
      .replace(/\n/g, ' ')         // flatten any embedded newlines
      .replace(/^>>\s*/g, '')      // strip speaker prefix ">>"
      .trim();

    if (!text) continue;

    const timestamp = msToTimestamp(event.tStartMs || 0);
    withTimestamps.push(`[${timestamp}] ${text}`);
    plainLines.push(text);
  }

  if (withTimestamps.length === 0) {
    return {
      success: false,
      message: 'Transcript data was fetched but contained no readable segments.'
    };
  }

  const videoTitle = document.title
    .replace(/\s*-\s*Google Drive\s*$/i, '')
    .trim();

  return {
    success: true,
    withTimestamps: withTimestamps.join('\n'),
    plainText: plainLines.join(' '),
    title: videoTitle,
    segmentCount: withTimestamps.length,
    message: `Extracted ${withTimestamps.length} segments`
  };
}


// ============================================================
// HELPERS
// ============================================================

/**
 * Converts milliseconds to a human-readable timestamp string.
 * Examples:  3723000 ms → "1:02:03"
 *              65000 ms → "1:05"
 */
function msToTimestamp(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
