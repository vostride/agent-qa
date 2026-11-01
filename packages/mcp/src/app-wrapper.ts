// A pure page string, stateless per SEP-2575: it holds no session and mints nothing.

// The DOM cells range over this list, so a state added without a cell shows up as a diff.
export const APP_WRAPPER_STATES = [
  'connecting',
  'live',
  'expired',
  'unreachable-origin',
  'run-ended',
] as const

export type AppWrapperState = (typeof APP_WRAPPER_STATES)[number]

/** What the page says while the inner frame has not painted yet. */
export const APP_WRAPPER_CONNECTING_MESSAGE = 'connecting to the live view…'

// Under `script-src 'none'` this hint is all the page says, so it points at the link in markup.
export const APP_WRAPPER_CONNECTING_HINT
  = 'if the pane does not appear, open it in your browser'

/** What the page says once the inner frame has loaded on an origin this host can reach. */
export const APP_WRAPPER_LIVE_MESSAGE = 'live'

// The embed's `link expired` means a refused socket; this one means the App's link aged out.
export const APP_WRAPPER_EXPIRED_MESSAGE = 'live link expired'

// No re-mint happens inside the sandbox; a fresh token comes from another watch call.
export const APP_WRAPPER_EXPIRED_HINT = 'ask to watch again — a fresh watch mints a new link'

export const APP_WRAPPER_UNREACHABLE_MESSAGE =
  "this host can't reach the live view — open it in your browser"

export const APP_WRAPPER_RUN_ENDED_MESSAGE = 'this run is not live — open it in your browser'

export const APP_WRAPPER_PERMANENT_LINK_LABEL = 'open in your browser'

// A black-holed origin never answers and a loopback dashboard answers in ms; nothing sits between.
export const APP_WRAPPER_LOAD_TIMEOUT_MS = 10_000

// ext-apps carries `2025-11-21` and `2026-01-26`; its `AppBridge` treats `2026-01-26` as latest.
export const APP_WRAPPER_UI_PROTOCOL_VERSION = '2026-01-26'

/**
 * What this document calls itself to a host (`ui/initialize`'s required `appInfo`).
 *
 * Exported so a cell asserts the SAME bytes the page posts, per this file's standing rule that a
 * value a person or a host can observe is never restated in a test.
 */
export const APP_WRAPPER_APP_NAME = 'agent-qa-live-view'

/** The wrapper's own version, bumped only when the handshake it performs changes. */
export const APP_WRAPPER_APP_VERSION = '1.0.0'

// `liveUrl` holds the token in its fragment; it goes into the frame's `src` and nowhere else.
export interface AppWrapperMint {
  readonly handle: number
  readonly liveUrl: string
  readonly expiresAt: number
  readonly streamKind: string
}

export interface AppWrapperInput {
  readonly runId: string
  // One mint per handle on the announced roster; empty means not live.
  readonly mints: readonly AppWrapperMint[]
  /** The tokenless dashboard page. `undefined` when no dashboard origin is composable. */
  readonly permanentLink: string | undefined
  /** Whether this host holds a live session for the run at all. `false` renders `run-ended`. */
  readonly runLive: boolean
  // A parameter so a cell can choose the instant; defaults to the wall clock.
  readonly now?: number
}

const STYLE = `
  :root { color-scheme: dark light }
  html, body { margin: 0; height: 100%; background: #0b0d10; }
  main { display: grid; grid-template-rows: auto 1fr auto auto; height: 100%; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #c9d1d9; }
  header { display: flex; gap: .75rem; align-items: center; padding: .5rem .75rem; }
  header:empty { display: none; }
  iframe { border: 0; width: 100%; height: 100%; display: none; background: #0b0d10; }
  main[data-app-state="live"] iframe { display: block; }
  main[data-app-state="live"] p[data-app-message] { display: none; }
  main[data-app-state="live"] p[data-app-hint] { display: none; }
  p[data-app-message] { margin: 0; padding: .5rem .75rem; }
  p[data-app-hint] { margin: 0; padding: 0 .75rem .5rem; opacity: .75; }
  p[data-app-hint]:empty { display: none; }
  footer { padding: .5rem .75rem; }
  select[hidden], a[hidden] { display: none; }
`

/** The sentence each state shows, and the second line it shows underneath. */
const MESSAGES: Readonly<Record<AppWrapperState, string>> = {
  connecting: APP_WRAPPER_CONNECTING_MESSAGE,
  live: APP_WRAPPER_LIVE_MESSAGE,
  expired: APP_WRAPPER_EXPIRED_MESSAGE,
  'unreachable-origin': APP_WRAPPER_UNREACHABLE_MESSAGE,
  'run-ended': APP_WRAPPER_RUN_ENDED_MESSAGE,
}

const HINTS: Readonly<Record<AppWrapperState, string>> = {
  connecting: APP_WRAPPER_CONNECTING_HINT,
  live: '',
  expired: APP_WRAPPER_EXPIRED_HINT,
  'unreachable-origin': '',
  'run-ended': '',
}

// Only absolute `http:` or `https:` survives: a `javascript:` base would run in the sandbox.
function httpPermanentLink(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined
}

// The whole document every time; a stale App is answered by a fresh read that mints again.
export function renderAppWrapperPage(input: AppWrapperInput): string {
  // The `scriptLiteral` escape of `renderLiveEmbedPage`, copied verbatim rather than
  // re-derived: the value lands inside a script as a STRING LITERAL and the `<` guard closes the
  // one hole that leaves.
  // ONE helper for every value that enters the script, so the guard cannot be forgotten for a new
  // one — including the handle numbers, which enter as literals like everything else so that
  // "every value crosses the helper" is a property a reader can check by grepping for the calls.
  const scriptLiteral = (value: string) => JSON.stringify(value).replaceAll('<', '\\u003c')

  // THE SECOND HELPER, AND THE ONLY ONE FOR HTML ATTRIBUTE CONTEXT. It exists for exactly one
  // value — the permanent link's `href` and its label — which is the one thing this document renders
  // into MARKUP rather than assigning from the script, because the link is the primary
  // representation and must survive a host that runs no script. `&` goes first or the later
  // replacements would be re-escaped.
  //
  // THE TWO HELPERS MUST NEVER BE USED IN EACH OTHER'S CONTEXT. `scriptLiteral` remains the one
  // helper for EVERY value entering the script and produces a quoted JS literal, which is not an
  // attribute value; this one produces attribute text and does nothing about the `</script` hole.
  // Swapping them silently reopens exactly the guard the other one closes.
  const attributeText = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')

  const now = input.now ?? Date.now()

  // With `runLive` false the urls never reach the script, so a not-live page carries no token.
  const live = input.runLive && input.mints.length > 0
  const mints = live ? input.mints : []

  // The LOWEST expiry among the panes, because the document expires when the first of its links
  // does: showing a person a picker whose other option is already dead would be a worse lie than
  // saying the whole thing aged out.
  const lowestExpiry = mints.reduce(
    (lowest, mint) => (mint.expiresAt < lowest ? mint.expiresAt : lowest),
    Number.POSITIVE_INFINITY,
  )
  const expired = live && lowestExpiry <= now
  // A delta, not a deadline, so the host's clock never enters it; clamped at zero because this
  // render already turned a negative one into the `expired` initial state.
  const expiresInMs = expired || !live ? 0 : Math.max(0, lowestExpiry - now)

  const initialState: AppWrapperState = !live ? 'run-ended' : expired ? 'expired' : 'connecting'

  const mintsLiteral = (expired ? [] : mints)
    .map(
      (mint) =>
        `{handle:${scriptLiteral(String(mint.handle))},`
        + `url:${scriptLiteral(mint.liveUrl)},`
        + `kind:${scriptLiteral(mint.streamKind)}}`,
    )
    .join(',')

  // Complete IN THE MARKUP, href and label both, so the way out exists before a single line of
  // script has run — and absent entirely for a link this renderer will not vouch for.
  const permanentLink = httpPermanentLink(input.permanentLink)
  const permanentLinkSlot
    = permanentLink === undefined
      ? ''
      : '<a data-app-permanent-link rel="noreferrer" target="_blank" href="'
        + attributeText(permanentLink)
        + '">'
        + attributeText(APP_WRAPPER_PERMANENT_LINK_LABEL)
        + '</a>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-qa live run</title>
<style>${STYLE}</style>
</head>
<body>
<main data-app-state="${initialState}">
<header><select data-app-handle-picker hidden></select></header>
${live && !expired ? '<iframe data-app-live-frame sandbox="allow-scripts" referrerpolicy="no-referrer" title="agent-qa live view"></iframe>' : ''}
<p data-app-message>${MESSAGES[initialState]}</p>
<p data-app-hint>${HINTS[initialState]}</p>
<footer>${permanentLinkSlot}</footer>
</main>
<script>
(function () {
  var mints = [${mintsLiteral}];
  var runId = ${scriptLiteral(input.runId)};
  var expiresInMs = ${String(expiresInMs)};
  var loadTimeoutMs = ${String(APP_WRAPPER_LOAD_TIMEOUT_MS)};
  var messages = {
    connecting: ${scriptLiteral(APP_WRAPPER_CONNECTING_MESSAGE)},
    live: ${scriptLiteral(APP_WRAPPER_LIVE_MESSAGE)},
    expired: ${scriptLiteral(APP_WRAPPER_EXPIRED_MESSAGE)},
    'unreachable-origin': ${scriptLiteral(APP_WRAPPER_UNREACHABLE_MESSAGE)},
    'run-ended': ${scriptLiteral(APP_WRAPPER_RUN_ENDED_MESSAGE)}
  };
  var hints = {
    connecting: ${scriptLiteral(APP_WRAPPER_CONNECTING_HINT)},
    live: '',
    expired: ${scriptLiteral(APP_WRAPPER_EXPIRED_HINT)},
    'unreachable-origin': '',
    'run-ended': ''
  };

  var root = document.querySelector('[data-app-state]');
  var frame = document.querySelector('[data-app-live-frame]');
  var picker = document.querySelector('[data-app-handle-picker]');
  var message = document.querySelector('[data-app-message]');
  var hint = document.querySelector('[data-app-hint]');

  // The run id enters through setAttribute from an escaped literal, so it never becomes markup.
  root.setAttribute('data-app-run-id', runId);

  // The state machine is an ATTRIBUTE plus two textContent writes, exactly as the embed page's is:
  // a state a person can read off the DOM is a state a cell can assert without screenshotting, and
  // text that arrives through textContent can never become markup.
  function setState(state) {
    root.setAttribute('data-app-state', state);
    message.textContent = messages[state] || '';
    hint.textContent = hints[state] || '';
  }

  // ---- The minimal ui/initialize handshake (ext-apps spec shape) -------------------------------
  //
  // Hand-rolled: this page has no bundler to load ext-apps' app-bridge.
  try {
    if (window.parent !== window) {
      window.parent.postMessage({
        jsonrpc: '2.0',
        id: 'ui-init-1',
        method: 'ui/initialize',
        params: {
          protocolVersion: ${scriptLiteral(APP_WRAPPER_UI_PROTOCOL_VERSION)},
          appInfo: { name: ${scriptLiteral(APP_WRAPPER_APP_NAME)}, version: ${scriptLiteral(APP_WRAPPER_APP_VERSION)} },
          appCapabilities: {}
        }
      }, '*');
    }
  } catch (e) { /* a host that refuses the message changes nothing about what this page shows */ }

  if (mints.length === 0) {
    // The renderer already wrote the terminal or expired state, and no src was ever assigned.
    return;
  }

  // ---- Reachability, once per ORIGIN ------------------------------------------------------------
  //
  // Only success is cached: every pane shares one origin, so a cached refusal would be permanent.
  var reach = {};
  function reachable(url) {
    var origin;
    try { origin = new URL(url).origin; } catch (e) { return Promise.resolve(false); }
    if (reach[origin] === undefined) {
      reach[origin] = fetch(origin + '/', { mode: 'no-cors', cache: 'no-store' })
        .then(function () { return true; })
        .catch(function () { delete reach[origin]; return false; });
    }
    return reach[origin];
  }

  var attachId = 0;

  function attach(mint) {
    // Expired is terminal; a picker change after the one-shot expiry timer must not leave it.
    if (root.getAttribute('data-app-state') === 'expired') return;
    var mine = (attachId += 1);
    var loaded = false;
    var settled = false;

    function settle(state) {
      if (settled || mine !== attachId) return;
      if (root.getAttribute('data-app-state') === 'expired') return;
      settled = true;
      setState(state);
    }

    setState('connecting');
    // THE ONLY PLACE A TOKEN IS WRITTEN. It goes into the frame's src and nowhere else.
    frame.src = mint.url;

    frame.addEventListener('error', function () { settle('unreachable-origin'); }, { once: true });
    frame.addEventListener('load', function () {
      // NECESSARY, NOT SUFFICIENT: Chromium fires this for a refused connection too,
      // so the probe is what decides — a frame that loaded on an origin nothing answered for is an
      // error page, and calling that 'live' is the failure this arm exists to prevent.
      loaded = true;
      reachable(mint.url).then(function (ok) { settle(ok ? 'live' : 'unreachable-origin'); });
    }, { once: true });

    reachable(mint.url).then(function (ok) {
      if (!ok) settle('unreachable-origin');
      else if (loaded) settle('live');
    });

    // A black-holed origin fires no error and never loads; silence past this bound is the signal.
    setTimeout(function () { settle('unreachable-origin'); }, loadTimeoutMs);
  }

  // The deadline arrives as a delta from render time, so the host's own clock never enters it.
  if (expiresInMs > 0) {
    setTimeout(function () {
      attachId += 1;
      // Unconditional: the script returned above when mints was empty, and a non-empty mints is
      // exactly the condition under which the renderer emits the iframe, so there is no reachable
      // state in which this callback runs without a frame to strip.
      frame.removeAttribute('src');
      // The picker is an affordance of the EMBEDDED variant; when the variant is gone the
      // affordance goes with it, so the control a person can reach and the state the document is in
      // cannot disagree.
      picker.setAttribute('disabled', '');
      setState('expired');
    }, expiresInMs);
  }

  // The picker swaps among tokens minted for this render; only a fresh watch call re-mints.
  for (var i = 0; i < mints.length; i += 1) {
    var option = document.createElement('option');
    option.value = String(i);
    option.textContent = 'handle ' + mints[i].handle;
    picker.appendChild(option);
  }
  if (mints.length > 1) picker.removeAttribute('hidden');
  picker.addEventListener('change', function () {
    var chosen = mints[Number(picker.value)];
    if (chosen !== undefined) attach(chosen);
  });

  attach(mints[0]);
}());
</script>
</body>
</html>
`
}
