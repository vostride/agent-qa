// The MCP App WRAPPER page (408 D-04/D-06/D-07/D-10/D-11, ratified 2026-08-31; finished in plan 02).
//
// WHAT THIS DOCUMENT IS. A thin host-rendered page that IFRAMES the `liveUrl` Phase 403 already
// mints and serves. It is not a second embed document: the 403 embed page
// (`dashboard-server/src/live-view/embed-page.ts`) stays byte-identical and this file re-implements
// none of it — no socket, no canvas, no frame protocol, no token parse. One embed contract, two
// consumers. Copying that file's IDIOMS is deliberate; copying its BYTES would be the
// second implementation this milestone exists to retire.
//
// IT RENDERS NO RUN STATE OF ITS OWN. No step list, no status line, no verdict. Those need
// an event-stream credential story inside a sandboxed iframe that this phase refuses to invent; the
// full two-pane surface stays the dashboard's, one click away through the permanent link. What this
// page owns is the closed state set below, the handle picker, and the link slot.
//
// EVERY ABSENCE IS NAMED, inherited verbatim from the embed page's own header. There is no state in
// which this page shows a blank rectangle: a run with no live session says so by name
// (`run-ended`), a host that cannot reach the dashboard origin says so (`unreachable-origin`), and
// an elapsed token says so (`expired`) rather than leaving a dead frame under a spinner.
//
// A MEASURED FACT THAT SHAPES THE `live` ARM, and the reason this page probes rather than trusting
// an event (measured 2026-08-31, Chromium; the cell is `cli/src/__tests__/app-wrapper-dom.test.ts`):
// AN IFRAME POINTED AT A REFUSED CONNECTION STILL FIRES `load`. The browser navigates the frame to
// its own error page and that navigation completes, so `load` says "a document settled in there",
// never "the origin answered". A wrapper whose only signal was `load` would therefore label
// Chromium's error page `live` — the blank inner frame D-11 forbids, wearing the one label that
// stops a person from looking further. Cross-origin, this page cannot look inside the frame to
// tell the difference, and it must not ask the INNER page to tell it (criterion 3 freezes that
// document). So reachability is established by an explicit `fetch(origin, { mode: 'no-cors' })`
// probe — the one question a sandboxed page can honestly ask about somebody else's origin — and
// `live` requires BOTH the probe answering and the frame loading. The probe is memoised per
// ORIGIN, so the handle picker swaps among panes on one origin with no network call at all.
//
// AND THE MEMO IS ASYMMETRIC — SUCCESS ONLY (2026-09-01, WR-06, T-408-23; the cell is
// `app-wrapper-dom.test.ts` cell (8)). A `true` is a durable fact about an origin that ANSWERED, so
// it is cached and the zero-request property above depends on it and on nothing else. A `false` is
// a fact about ONE MOMENT — a dashboard restarting, a refusal during the first paint — and it is
// discarded, so the next call probes again. Caching it bought nothing the `true` was not already
// buying, and cost everything: all of a render's mints share one origin, so a single transient
// failure answered `false` for the LIFE of the document, pinning every later handle swap to
// `unreachable-origin` instantly, with no network call and no path back. A momentary observation
// about somebody else's origin does not get to outlive the moment.
//
// THE TIMEOUT ARM IS STILL REQUIRED, because the other unreachable shape does not fail fast: an
// origin that black-holes packets (the cloud-host-versus-loopback case D-11 was written for) leaves
// both the probe and the frame pending forever. `APP_WRAPPER_LOAD_TIMEOUT_MS` is the bound past
// which silence is itself the answer, named rather than left as a spinner.
//
// EXPIRY IS DECIDED AT RENDER TIME. The clock is read ONCE, by the renderer, and what enters
// the script is a DELTA in milliseconds — never an absolute epoch the script would compare against
// the HOST's clock. A wrapper rendered on a machine whose clock differs from the host's by a minute
// would otherwise expire a minute early or a minute late for no reason a person could see. If every
// mint has already aged out by the time the document is built, the document is BORN `expired`: it
// never assigns a src, so there is no dead frame to flash before the sentence appears.
//
// AND `expired` IS ABSORBING (2026-09-01; the cell is `cli/src/__tests__/app-wrapper-dom.test.ts`
// cell (6), and 408-VERIFICATION.md is where the defect was measured). The expiry timer is
// ONE-SHOT, so for as long as anything could re-enter `attach()` the document could be walked back
// OUT of its terminal state: a handle-picker change re-pointed the frame at an already-aged
// `liveUrl` and painted the word `live` over a dead pane, permanently — the outcome this header
// already calls worse than a blank frame. `attach()` therefore returns immediately when the
// document already reads `expired`, and the expiry callback DISABLES the picker, because an
// affordance that outlives the thing it operates on is a second lie. Read against D-08: the
// permanent link is the PRIMARY way to watch a run and the embedded pane is one credential-bounded,
// time-bounded variant of it, so `expired` is not an interruption of the resting state — it is the
// RETURN to it, and returns are one-way. Cell (6) renders with a short TTL, waits for `expired`,
// changes the picker, and asserts the document is still `expired` with no frame src and still
// carrying the link and the hint D-10 requires it to carry.
//
// SELF-CONTAINED AND PURE. No imports, no external stylesheet, no build step: the whole document is
// the string this function returns, because a host renders it inside a sandbox with no network
// identity of its own. `renderAppWrapperPage` is a pure function of its input (the clock included,
// which is why `now` is a parameter and not a call), so a cell drives it directly.
//
// VALUES ENTER THE SCRIPT AS STRING LITERALS AND LAND AS `textContent`. The escape
// helper is `embed-page.ts`'s, copied because the guard must not be re-derived: `JSON.stringify`
// plus a `<` escape closes the `</script` hole. The picker's options and the run id are BUILT in
// the script rather than templated above it, so nothing caller-supplied has to be trusted to markup.
//
// WITH ONE AMENDED EXCEPTION, AMENDED HERE RATHER THAN REVERSED IN SILENCE (2026-09-01; the cells
// are `app-wrapper.test.ts`'s markup-anchor, scheme-drop and attribute-escape cells, and
// `app-wrapper-dom.test.ts` cell (7)). THE PERMANENT LINK'S `href` AND LABEL ARE NOW RENDERED INTO
// MARKUP. The rule above was sound and its conclusion was wrong for exactly this one value. Under
// D-08 the permanent link is the PRIMARY way to watch a run, and a primary representation produced
// by the script is unavailable on precisely the host it exists to cover: a host serving this
// document under `script-src 'none'` (WR-10, RESEARCH assumption A1) runs NONE of this script, so
// the anchor stayed empty, the frame stayed hidden and the document sat forever under the
// connecting sentence — the pane with no way out that this header already calls worse than a blank
// frame. Two guards PAY for the exception rather than relaxing the rule:
//   (a) a SECOND, separately named escape helper for HTML ATTRIBUTE context (`attributeText`),
//       used for this one value and nothing else, never for a value entering the script; and
//   (b) a SCHEME CHECK that DROPS a `permanentLink` which is not `http:` or `https:`, so a hostile
//       base composes no anchor at all rather than a new kind of one (WR-04's anchor hop — the
//       parse-time hop is the dashboard config schema's, and this renderer is exported and drivable
//       directly, so it guards its own input rather than trusting a boundary it cannot see).
// The connecting state carries a NAMED HINT for the same reason: a server-rendered document that
// says only "connecting" is making a claim its own script has to keep, and on that host it cannot.
//
// Protocol grounding. This module speaks no protocol at all — it returns a string — and the two
// SEPs that nonetheless shape it are the reason it can. SEP-1730 places extensions outside every
// conformance tier, so this page is rendered only by a host that OPTED IN to the Apps extension and
// a host that did not owes it nothing: there is no degraded rendering to design for, only the
// link-out that rides every carrier result. SEP-2575's stateless protocol is why the page holds no
// session and mints nothing: it is handed everything it will ever have at render time, which is
// what makes D-10's answer to an aged token another READ rather than a credential machine inside
// somebody else's sandbox.

/**
 * Every value `[data-app-state]` can take (D-11's closed set).
 *
 * Exported for the reason `LIVE_EMBED_STATES` is: the DOM cells range over this list, so a state
 * added to the page without a cell is a visible diff rather than an unobserved arm.
 */
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

/**
 * The second line under `connecting`, and the WHOLE of what an initial render says on a host that
 * never runs this document's script (WR-10, RESEARCH assumption A1; the cell is
 * `app-wrapper-dom.test.ts` cell (7)).
 *
 * Named for the same reason every other absence here is named: a document that says only that it is
 * connecting has made a promise its own script has to keep, and under a host CSP of
 * `script-src 'none'` there is no script to keep it. The sentence therefore points at the ONE
 * useful action available with no script at all — the permanent link rendered directly beneath it,
 * which is now markup rather than something the script assigns. One useful action, no apology.
 */
export const APP_WRAPPER_CONNECTING_HINT
  = 'if the pane does not appear, open it in your browser'

/** What the page says once the inner frame has loaded on an origin this host can reach. */
export const APP_WRAPPER_LIVE_MESSAGE = 'live'

/**
 * What an elapsed live link says.
 *
 * The wrapper's own sentence rather than the embed page's `link expired`, because the two are about
 * different things: the embed says its socket was refused, and this says the link this App was
 * rendered with has aged out.
 */
export const APP_WRAPPER_EXPIRED_MESSAGE = 'live link expired'

/**
 * The second half of the expired state, and the WHOLE of D-10's refresh story.
 *
 * There is no re-mint inside this sandbox and there is never going to be one — a UI-initiated mint
 * door was rejected precisely because its model-context hygiene is per-host behaviour nobody here
 * controls. What replaces it is this sentence: the way to a fresh token is another watch call, one
 * the person can simply ask for, and saying so is the difference between a dead end and a next
 * move. Separate from the message above so the DOM can show both and a cell can assert each.
 */
export const APP_WRAPPER_EXPIRED_HINT = 'ask to watch again — a fresh watch mints a new link'

/**
 * The REQUIRED unreachable-origin sentence, spelled EXACTLY as CONTEXT ratified it.
 *
 * A host running somewhere that cannot route to a loopback dashboard origin must say so and offer
 * the browser, never show a blank inner frame. This string is a contract: the DOM cells assert
 * against this constant, so the sentence and the assertion can never drift apart.
 */
export const APP_WRAPPER_UNREACHABLE_MESSAGE =
  "this host can't reach the live view — open it in your browser"

/**
 * What a run with no live session on this host says.
 *
 * Not an error and not a blank frame — and it points at the way to see the run anyway, which is
 * the permanent link rendered directly beneath it. A run that has finished still HAPPENED, and the
 * dashboard's own page is where its history lives.
 */
export const APP_WRAPPER_RUN_ENDED_MESSAGE = 'this run is not live — open it in your browser'

/** The label on the permanent link-out slot, when one is composed. */
export const APP_WRAPPER_PERMANENT_LINK_LABEL = 'open in your browser'

/**
 * How long silence from the inner frame is allowed to last before it is named.
 *
 * Exported because the DOM cell must wait on the page's OWN bound rather than on a number a test
 * file guessed. Ten seconds is chosen against the two shapes this arm exists for: a black-holed
 * origin never answers at all, and a slow-but-reachable dashboard on loopback answers in
 * milliseconds — there is no realistic case in between, so a longer bound would only make a person
 * stare at a spinner for longer before reading the same sentence.
 */
export const APP_WRAPPER_LOAD_TIMEOUT_MS = 10_000

/**
 * The MCP Apps protocol version this wrapper announces in its `ui/initialize` request.
 *
 * MEASURED, not guessed (408-06 Task 1): `@modelcontextprotocol/ext-apps@1.7.5` carries exactly
 * two protocol versions — `2025-11-21` and `2026-01-26` — and `2026-01-26` is the one its
 * `AppBridge` treats as latest. `ext-apps-constants.test.ts` pins the spelling against the
 * package's own shipped schema, so this literal cannot drift from the vocabulary in silence.
 */
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

/**
 * ONE minted view onto ONE member handle of the run.
 *
 * `liveUrl` carries its token in the FRAGMENT, so this value is the only place a live
 * credential exists on this page — it is written into the frame's `src` and nowhere else: not into
 * the document text, not into the picker's labels, not into any attribute a host serialises back.
 */
export interface AppWrapperMint {
  readonly handle: number
  readonly liveUrl: string
  readonly expiresAt: number
  readonly streamKind: string
}

export interface AppWrapperInput {
  readonly runId: string
  /** One mint per handle on the run's announced roster. Empty is the D-07 not-live case. */
  readonly mints: readonly AppWrapperMint[]
  /** The tokenless dashboard page. `undefined` when no dashboard origin is composable. */
  readonly permanentLink: string | undefined
  /** Whether this host holds a live session for the run at all. `false` renders `run-ended`. */
  readonly runLive: boolean
  /**
   * The instant this document is being built, in ms-epoch.
   *
   * A PARAMETER rather than a `Date.now()` call, for the reason every clock in this repository is a
   * port: the expiry arm is the one thing this renderer decides about time, and a cell that cannot
   * choose "now" could only ever assert the arm it happened to land in. Defaults to the wall clock,
   * so the read handler passes nothing and gets the honest answer.
   */
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

/**
 * The `permanentLink` this renderer is willing to put in an `href`, or `undefined`.
 *
 * A URL-shaped OPERATOR config value (`services.dashboard.baseUrl`) reaches this function, and the
 * document it lands in runs with `allow-scripts` at an opaque origin, so a base of
 * `javascript:alert(1)` would compose a script-executing anchor. Anything that is not an absolute
 * `http:`/`https:` URL is therefore treated EXACTLY as an absent link: no anchor at all. That is
 * deliberate reuse rather than a new arm — absence is already the tested, honest posture for `no
 * dashboard origin is composable`, so a hostile base collapses into a state this document already
 * knows how to be in, instead of inventing one nobody has looked at.
 *
 * Defensive, not redundant: the config schema refuses the same shape at PARSE time, but
 * `renderAppWrapperPage` is exported and drivable directly, and it receives its link from a
 * supplier rather than from a freshly parsed config.
 */
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

/**
 * Render the App wrapper for one run.
 *
 * The whole document, every time — there is no partial render and no update path, because D-10's
 * answer to a stale App is a FRESH read that mints again rather than a credential machine inside
 * the sandbox.
 */
export function renderAppWrapperPage(input: AppWrapperInput): string {
  // The embed page's escape, copied verbatim (embed-page.ts:72) rather than re-derived: the value
  // lands inside a script as a STRING LITERAL and the `<` guard closes the one hole that leaves.
  // ONE helper for every value that enters the script, so the guard cannot be forgotten for a new
  // one — including the handle numbers, which enter as literals like everything else so that
  // "every value crosses the helper" is a property a reader can check by grepping for the calls.
  const scriptLiteral = (value: string) => JSON.stringify(value).replaceAll('<', '\\u003c')

  // THE SECOND HELPER, AND THE ONLY ONE FOR HTML ATTRIBUTE CONTEXT. It exists for exactly one
  // value — the permanent link's `href` and its label — which is the one thing this document renders
  // into MARKUP rather than assigning from the script (see the header's dated amendment: the link
  // is the primary representation and must survive a host that runs no script). `&` goes first or
  // the later replacements would be re-escaped.
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

  // THE RENDERER IS AUTHORITATIVE ABOUT WHETHER A PANE EXISTS, rather than trusting the record it
  // was handed. `runLive: false` means the document must not be ABLE to show a pane, so the urls
  // never reach the script at all — a not-live document that still carried a minted token would be
  // a credential shipped for no reason, which is the one thing D-01's channel argument cannot
  // tolerate. The same line makes "zero surviving mints ⇒ not live" (408-01 D-C) structural here.
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
  // The DELTA, not the deadline — see the header. Clamped at zero because a negative timeout is a
  // fact about this render, and this render already turned it into the `expired` initial state.
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

  // WHICH RUN, as an attribute rather than as prose. Identity is not run STATE (D-11 forbids the
  // second, not the first), and it enters through setAttribute from an escaped literal, so a run
  // id can never become markup no matter what it spells.
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
  // HAND-ROLLED AND DELIBERATELY ISOLATED IN THIS ONE BLOCK. The ext-apps package
  // declares a peer on the v1 monolith SDK, so importing its app-bridge into production would drag
  // a second SDK generation in (Pitfall 3) — and this page has no bundler anyway. RESEARCH
  // assumption A5 rated the method-name and field spellings MEDIUM (single spec fetch), and plan
  // 02's coverage entry D9 deferred the adjudication to plan 06.
  //
  // PLAN 06 MEASURED IT, AND IT HAD DRIFTED. Against the installed
  // @modelcontextprotocol/ext-apps@1.7.5's own generated schema, McpUiInitializeRequest.params
  // requires THREE members: protocolVersion, appInfo and appCapabilities. This block sent only the
  // first, so a host validating the request against the published schema would have rejected the
  // handshake outright, and the failure would have looked like a host that simply does not support
  // Apps. The two missing members are now sent, and ext-apps-constants.test.ts cell (4d) derives
  // the required list FROM the shipped schema rather than restating it, so the next spec change
  // reds here instead of on a user's machine.
  //
  // IT STILL ASKS FOR NOTHING. appCapabilities is deliberately empty: this document exposes no
  // tools, requests no display mode and declares no experimental feature (the schema requires no
  // member of it). No permissions, no re-mint (D-10) — it announces that this document is ready,
  // which is all a wrapper that renders no run state of its own has to say.
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
    // Either D-07's honest terminal/unknown state or D-10's expired one — both were decided by the
    // RENDERER and are already in the markup. No src was ever assigned, so there is no blank frame
    // to mistake for a stalled one, and nothing below this line can move the document off them.
    return;
  }

  // ---- Reachability, once per ORIGIN (see the header's measured note) ---------------------------
  //
  // Memoised deliberately, and ONLY ON SUCCESS. The picker swaps among panes that share one
  // origin, so after the first ANSWERING pane every swap is served from this map and issues NO
  // network request at all (D-06/D-10's zero re-mints, zero calls, which the DOM cell counts) — a
  // property that rides entirely on caching the true. The catch arm therefore FORGETS the entry
  // before answering false: a refusal is a fact about one moment, not about the origin, and every
  // mint on a render shares one origin, so a cached false was total and permanent. See the header.
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
    // THE EXPIRED STATE IS TERMINAL, AND THIS IS THE ONE PLACE IT COULD BE LEFT (D-10). The
    // picker's change handler — and nothing else — can reach this function after the one-shot
    // expiry timer has fired; without this line the next statements would set the connecting state
    // and assign an aged token over a document that had already told the truth, and no timer would
    // ever correct it. The identical predicate inside settle() stays where it is: it closes the
    // OTHER door, a probe or a frame load that was already in flight when the timer fired, so
    // neither guard makes the other dead.
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
      // NECESSARY, NOT SUFFICIENT: Chromium fires this for a refused connection too (header note),
      // so the probe is what decides — a frame that loaded on an origin nothing answered for is an
      // error page, and calling that 'live' is the failure this arm exists to prevent.
      loaded = true;
      reachable(mint.url).then(function (ok) { settle(ok ? 'live' : 'unreachable-origin'); });
    }, { once: true });

    reachable(mint.url).then(function (ok) {
      if (!ok) settle('unreachable-origin');
      else if (loaded) settle('live');
    });

    // D-11's REQUIRED arm for the origin that never answers at all: a black-holed host fires no
    // error and never loads, so silence past this bound is itself the signal, named rather than
    // left as a spinner.
    setTimeout(function () { settle('unreachable-origin'); }, loadTimeoutMs);
  }

  // D-10: the deadline was computed at RENDER time and arrives as a delta, so the host's own clock
  // never enters the comparison. When it fires the document says so and stops — nothing here mints.
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

  // D-06/D-10: the picker swaps among tokens ALREADY minted for this render. It never mints, and
  // there is no bridge here that could ask anyone to — a fresh watch call is what re-mints.
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
