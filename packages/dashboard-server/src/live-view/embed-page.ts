// Self-contained and nonce'd; every absence is named, and host reports never carry the token.

import { LIVE_VIEW_WS_PATH } from './protocol.js'

/** Every value `[data-embed-state]` can take. */
export type LiveEmbedState =
  | 'connecting'
  | 'live'
  | 'no-stream'
  | 'expired'
  | 'refused'
  | 'stream-ended'
  | 'session-ended'
  | 'ended'
  | 'lost'

// Every value `[data-embed-state]` can take.
// prettier-ignore
export const LIVE_EMBED_STATES = [
  'connecting',
  'live',
  'no-stream',
  'expired',
  'refused',
  // This member's stream ended while the run continues, so the viewer knows which one ended.
  'stream-ended',
  // An editor session ended; an editor subject has no run to end.
  'session-ended',
  'ended',
  'lost',
] as const satisfies readonly LiveEmbedState[]

/** Every fact the page reports to its host. */
export type LiveEmbedReportEvent = 'ready' | 'frame' | 'ended' | 'refused' | 'lost'
// prettier-ignore
export const LIVE_EMBED_REPORT_EVENTS = [
  'ready',
  'frame',
  'ended',
  'refused',
  'lost',
] as const satisfies readonly LiveEmbedReportEvent[]

/**
 * The query parameter a host sets when it draws its own status chrome (`/live/<id>?host=dashboard`).
 * Any non-empty value lands on `main[data-embed-host]` and hides the page's centred text.
 */
export const LIVE_EMBED_HOST_PARAM = 'host'

/** At most one `frame` report per this many milliseconds; the report carries the newest frame. */
export const LIVE_EMBED_REPORT_INTERVAL_MS = 500

// Exported so cells assert the same string the page renders.
export const LIVE_EMBED_EXPIRED_MESSAGE = 'link expired'

// The host is invisible to this page, so the sentence claims nothing about where steps are shown.
export const LIVE_EMBED_NO_STREAM_MESSAGE = 'no live preview for this target'

// What an ended editor session says, exactly.
export const LIVE_EMBED_SESSION_ENDED_MESSAGE = 'session ended'

const STYLE = `
  :root { color-scheme: dark light }
  html, body { margin: 0; height: 100%; background: #0b0d10; }
  main { display: grid; place-items: center; height: 100%; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #c9d1d9; }
  canvas { max-width: 100%; max-height: 100%; display: none; pointer-events: none; }
  main[data-embed-state="live"] canvas { display: block; }
  main[data-embed-state="live"] p { display: none; }
  main[data-embed-host] p { display: none; }
`

/**
 * Render the page for one run.
 *
 * `nonce` is minted per response by the caller and appears in both the CSP header and the two
 * inline elements; a page served twice never reuses one.
 */
export function renderLiveEmbedPage(input: { runId: string; nonce: string }): string {
  // JSON.stringify is the escape: the value lands inside a script as a STRING LITERAL, and the
  // `<` guard closes the one hole that leaves (a `</script` sequence inside it). One helper for
  // every value that enters the script, so the guard cannot be forgotten for a new one.
  const scriptLiteral = (value: string) => JSON.stringify(value).replaceAll('<', '\\u003c')
  const runIdLiteral = scriptLiteral(input.runId)
  const wsPathLiteral = scriptLiteral(LIVE_VIEW_WS_PATH)
  const expiredLiteral = scriptLiteral(LIVE_EMBED_EXPIRED_MESSAGE)
  const noStreamLiteral = scriptLiteral(LIVE_EMBED_NO_STREAM_MESSAGE)
  const sessionEndedLiteral = scriptLiteral(LIVE_EMBED_SESSION_ENDED_MESSAGE)
  const hostParamLiteral = scriptLiteral(LIVE_EMBED_HOST_PARAM)
  const reportIntervalLiteral = String(LIVE_EMBED_REPORT_INTERVAL_MS)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-qa live view</title>
<style nonce="${input.nonce}">${STYLE}</style>
</head>
<body>
<main data-embed-state="connecting" data-embed-frames="0">
<canvas data-embed-canvas width="0" height="0"></canvas>
<p data-embed-message>connecting…</p>
</main>
<script nonce="${input.nonce}">
(function () {
  var runId = ${runIdLiteral};
  var root = document.querySelector('[data-embed-state]');
  var canvas = document.querySelector('[data-embed-canvas]');
  var message = document.querySelector('[data-embed-message]');
  var ctx = canvas.getContext('2d');
  var frames = 0;

  // A HOST THAT SPEAKS FOR THIS PAGE says so in the query. The value only ever becomes an
  // attribute value, so it can hide text and nothing more.
  var hostHint = new URLSearchParams(location.search).get(${hostParamLiteral});
  if (hostHint) root.setAttribute('data-embed-host', hostHint);

  function setState(state, text) {
    root.setAttribute('data-embed-state', state);
    message.textContent = text;
  }

  // Facts for whichever page frames this one. Built only from closed-set words and numbers.
  function report(payload) {
    if (window.parent === window) return;
    try { window.parent.postMessage(payload, '*'); } catch (e) { /* a host that cannot receive changes nothing here */ }
  }

  var reportInterval = ${reportIntervalLiteral};
  var lastFrameReportAt = 0;
  var frameReportTimer = null;
  var newestFrame = null;

  function flushFrameReport() {
    frameReportTimer = null;
    if (newestFrame === null) return;
    var fact = newestFrame;
    newestFrame = null;
    lastFrameReportAt = Date.now();
    report({ event: 'frame', ts: fact.ts, kind: fact.kind, width: fact.width, height: fact.height });
  }

  // At most one frame report per interval, and always the newest: a trailing timer flushes it.
  function reportFrame(fact) {
    newestFrame = fact;
    if (frameReportTimer !== null) return;
    var wait = lastFrameReportAt + reportInterval - Date.now();
    if (wait <= 0) flushFrameReport();
    else frameReportTimer = setTimeout(flushFrameReport, wait);
  }

  function stopFrameReports() {
    newestFrame = null;
    if (frameReportTimer !== null) clearTimeout(frameReportTimer);
    frameReportTimer = null;
  }

  // THE TOKEN IS READ FROM THE FRAGMENT AND NEVER PUT BACK ANYWHERE. It is not written to the
  // document, not added to the socket URL, not reported to the host, and not stored — it goes
  // into one message and stays in this closure.
  var token = location.hash.slice(1);
  if (token === '') {
    setState('refused', 'missing token');
    return;
  }

  var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  var socket = new WebSocket(scheme + location.host + ${wsPathLiteral} + '?runId=' + encodeURIComponent(runId));
  socket.binaryType = 'arraybuffer';

  var pending = null;
  var ended = false;

  socket.addEventListener('open', function () {
    socket.send(JSON.stringify({ type: 'hello', token: token }));
  });

  socket.addEventListener('message', function (event) {
    if (typeof event.data !== 'string') {
      // The binary half of a frame pair. Paint it, count it, then ack — the ack is what asks the
      // producer for the next one, so it goes AFTER the paint is scheduled.
      if (pending === null) return;
      var header = pending;
      pending = null;
      // NO MIME TYPE: the decoder sniffs the bytes, so a JPEG screencast frame and a PNG snapshot
      // both paint in every host, not only in Chromium (428 RESEARCH A2).
      var blob = new Blob([event.data]);
      createImageBitmap(blob).then(function (bitmap) {
        if (canvas.width !== header.width || canvas.height !== header.height) {
          canvas.width = header.width;
          canvas.height = header.height;
        }
        ctx.drawImage(bitmap, 0, 0, header.width, header.height);
        bitmap.close();
        frames += 1;
        root.setAttribute('data-embed-frames', String(frames));
        if (!ended) setState('live', 'live');
        socket.send(JSON.stringify({ type: 'ack', id: header.id }));
        if (!ended) reportFrame(header);
      }).catch(function () {
        socket.send(JSON.stringify({ type: 'ack', id: header.id }));
      });
      return;
    }

    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    if (msg.type === 'ready') {
      // THE PAINTER IS CHOSEN BY THE DECLARED KIND — never by a browser name, an adapter class or
      // a transport guess (LIVE-04's prohibition). A snapshot paints on the same canvas (428 D-11).
      var kind = msg.stream ? msg.stream.kind : undefined;
      if (kind === 'cdp-screencast' || kind === 'snapshot') {
        setState('connecting', 'waiting for the first frame…');
      } else if (kind === 'none') {
        setState('no-stream', ${noStreamLiteral});
      } else {
        setState('no-stream', 'unsupported stream kind');
      }
      report({ event: 'ready', kind: kind });
      return;
    }
    if (msg.type === 'frame') {
      pending = { id: msg.id, width: msg.width, height: msg.height, ts: msg.ts, kind: msg.kind };
      return;
    }
    if (msg.type === 'refused') {
      ended = true;
      stopFrameReports();
      if (msg.reason === 'expired') setState('expired', ${expiredLiteral});
      else setState('refused', String(msg.reason));
      report({ event: 'refused', reason: msg.reason });
      return;
    }
    if (msg.type === 'ended') {
      // EVERY ABSENCE IS NAMED, AND THESE ARE DIFFERENT ABSENCES. Painting stops either way -- the
      // canvas is hidden outside the live state -- so no end can leave a frozen frame on screen
      // labelled as though it were still arriving.
      ended = true;
      stopFrameReports();
      if (msg.reason === 'handleFinished') setState('stream-ended', 'this target finished — the run is still going');
      else if (msg.reason === 'sessionEnded') setState('session-ended', ${sessionEndedLiteral});
      else setState('ended', 'run ended');
      report({ event: 'ended', reason: msg.reason });
      return;
    }
  });

  socket.addEventListener('close', function () {
    if (ended) return;
    if (root.getAttribute('data-embed-state') === 'expired') return;
    if (root.getAttribute('data-embed-state') === 'refused') return;
    stopFrameReports();
    setState('lost', 'connection lost');
    report({ event: 'lost' });
  });

  // A HOST THAT RE-MINTS replaces the fragment; the socket renews in place rather than reloading,
  // so a renewal never costs the viewer the stream it is watching (D-02).
  window.addEventListener('hashchange', function () {
    var next = location.hash.slice(1);
    if (next === '' || socket.readyState !== 1) return;
    token = next;
    socket.send(JSON.stringify({ type: 'renew', token: next }));
  });
}());
</script>
</body>
</html>
`
}
