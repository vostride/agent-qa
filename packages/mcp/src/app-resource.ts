// The MCP App resource surface — `ui://agent-qa/live-run/{runId}` (408 plan 01, D-01..D-07 · MCPA-01).
//
// WHY THIS FILE EXISTS. 403 made a run watchable at a `liveUrl`; a host that negotiated the official
// MCP Apps extension (`io.modelcontextprotocol/ui`) renders server-delivered HTML in a sandboxed
// iframe. This module is the join: one resource template whose read mints a `liveUrl` per member
// handle and serves the wrapper page that iframes them. Everything it registers, resolves and
// refuses follows `resources.ts` — the ratified template for a non-tool MCP surface in this package
// — because a second registration idiom would be a second set of rules for the same three
// questions (who may see it, what parses the address, what masks the answer).
//
// THE MINT CHANNEL IS THE WHOLE SECURITY ARGUMENT (D-01, T-408-01). `runs.liveurl` stays
// UNPROJECTED as a callable tool: a projected mint tool would put a live credential into
// model-readable tool-result text, which is the exact shape of T-395-R5-10, and masking it would
// make the tool useless. Instead the mint happens HERE, by reference, inside the App-rendering
// path. WHAT THAT BUYS, AT ITS REAL VALUE (corrected 2026-09-01, 408 gap round — see THE
// 2026-09-01 GAP-ROUND RULING below): this server writes the token into exactly ONE place, the
// `src` of the frame in the document this read serves, and what a caller does with a document it
// asked for is outside this server's reach. The earlier sentence here — "the token lands only in
// the HTML the HOST renders" — described a property of the CALLER as though it were a property of
// this server, and it is WITHDRAWN rather than deleted. The structural property that DOES hold is
// the one `token-absence.test.ts` measures: no OTHER channel this server emits — tool-result text,
// `structuredContent`, a refusal echo, a resource listing, a log line — carries the token.
//
// AND THAT IS WHY THIS SURFACE DOES NOT MASK ITS SERVED PAYLOAD — the one deliberate divergence
// from `resources.ts`, which masks its contents for a measured reason (a card composed from STORED
// data through a handler nothing else masks). This document is composed from data MINTED one
// millisecond earlier for this exact response, and the token is the payload: a masked token is a
// broken embed, so masking here would not be safety, it would be the failure mode. The refusal
// path masks exactly as `resources.ts`'s does, because a refusal echoes CALLER text and that is a
// different channel with the opposite answer. The split is by channel, and it is pinned by cells
// rather than by this paragraph.
//
// THE `ui://` READ CHANNEL — the full ruling (408 plan 02, adjudicated 2026-08-31; RESEARCH
// Open Question 2 / Pitfall 2; D-01, D-09, D-14). This is the disposition D-14 requires RECORDED
// rather than left silent, and all four clauses are load-bearing:
//
//   1. THE TOKEN CHANNEL IS HOST-RENDERED HTML (D-01). A minted `liveUrl` reaches a person only
//      inside the document a host paints in its sandbox. It is never tool-result text, never a
//      refusal echo, and never a listing.
//      SUPERSEDED IN PART, 2026-09-01: the WRITE half stands and the REACH half does not. What
//      stands, exactly as written: this server writes the token into one place and one place only,
//      the `src` of the frame in the document this read serves — never tool-result text, never a
//      refusal echo, never a listing, and `token-absence.test.ts` is the standing measurement of
//      that. What is WITHDRAWN is "reaches a person only inside the document a host paints":
//      whether the bytes this server serves are painted in a sandbox or consumed some other way is
//      a property of the CALLER and of what it does with a document it asked for, so that half
//      described the wrong party — the same over-claim :15-22 above already withdrew by name. See
//      THE 2026-09-01 GAP-ROUND RULING below, which names what the negotiation check is and what
//      it is for. Retained here rather than rewritten, because an adjudication in this repository
//      is re-grounded on the record, never edited away.
//   2. THE TEMPLATE IS UNLISTED. `{ list: undefined }` means the address never appears in a
//      `resources/list`, so no model-driven enumeration can walk to a minted token by discovery.
//   3. A NON-NEGOTIATED READ IS REFUSED, BEFORE ANYTHING IS MINTED. Unlistability alone only
//      closes discovery: a caller that already knows a run id could still read the address and
//      receive token bytes, which is T-408-01 and the posture D-09 explicitly rejected as sole
//      protection. So the read now asks the request itself whether it declared
//      `io.modelcontextprotocol/ui` in its capabilities (`negotiatedAppsExtension`, measured —
//      see below) and throws
//      `AppResourceNegotiationError` if it did not. The refusal happens BEFORE the roster read
//      and before the mint loop, so a refused read mints nothing at all: there is no token in
//      existence on that path to leak, rather than a token that something remembered to withhold.
//      SUPERSEDED IN PART, 2026-09-01: the PREDICATE and the refusal arm stand exactly as written;
//      the SECURITY reading of this clause does not. See THE 2026-09-01 GAP-ROUND RULING below,
//      which names what the check is and what it is for. Retained here rather than rewritten,
//      because an adjudication in this repository is re-grounded on the record, never edited away.
//   4. THE CREDENTIAL STAYS SHORT-LIVED AND VIEW-SCOPED. 403's `LIVE_URL_TTL_MS` is five minutes
//      and the token authorises watching pixels this caller can already read — so even the
//      negotiated channel hands out the narrowest thing that can render a live view (re-spelled
//      2026-10-02, 432-42: no caller holds a `read` scope since 432-20).
//   5. THE AUTHORIZATION BOUNDARY IS THE OPERATOR-GRANTED `read` SCOPE, CHECKED AT REGISTRATION
//      (added 2026-09-01, 408 gap round; D-02). This clause names what THIS SERVER CAN VERIFY, as
//      distinct from anything a caller says about itself. `registerAppResources` registers the
//      template only when all three of its conditions hold, and two of them ARE the boundary:
//      `visibleToCaller(mint.requiredScopes, caller.grantedScopes)` — and the same call for the
//      roster op — over the scopes the REGISTRY declares for the ops this surface reads through,
//      plus `mint.bindingStatus === 'bound'`. The scopes a caller holds are OPERATOR
//      CONFIGURATION: the `read` scope an operator wrote into that credential's entry in
//      `services.mcp.tokens`, or the unconditional grant the spawning process gets on stdio. This
//      server authenticates the bearer that carries them, so that is a fact it verifies rather
//      than a fact it is told. D-02 is the ratified decision that put the boundary there — "The
//      App rides the existing `read` scope… no new scope in the token vocabulary" — and a
//      composition failing any condition registers no template at all, so for such a caller this
//      address does not exist. Clause 3's check is a filter ON TOP of this; it is not this.
//      SUPERSEDED, 2026-10-01 (432-20, D-12/D-13): the scope half is deleted with every per-caller
//      permission — "every door can call every operation" — so the template registers for every
//      caller of a composition whose mint is bound. What bounds the credential now is what D-13
//      keeps: the loopback-only endpoint, its Host/Origin guards, the bound-mint floor, the
//      five-minute view-scoped token and the unlisted address. Retained here rather than
//      rewritten, on this file's own rule.
//
// THE 2026-09-01 GAP-ROUND RULING — ROAD `demote` (408-08 task 1: the user's checkpoint answer,
// quoted verbatim in `408-08-SUMMARY.md`). `408-VERIFICATION.md` gaps[2] and `408-REVIEW.md` CR-01
// measured clause 3 against the shipped SDK and found its SECURITY reading false. Three findings,
// in this file's "measured, not assumed" idiom:
//
//   (a) THE CHECK IS A HOST-CAPABILITY SIGNAL, NOT AN AUTHORIZATION CONTROL. On the modern
//       (2026-07-28) era the SDK's `_inputRequestCapabilityView` returns
//       `ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY]` VERBATIM, and the 2026 codec's
//       `checkInboundEnvelope` validates that member's SHAPE and nothing else (the 2025 codec's
//       is `(_material) => void 0`). Measured 2026-08-31 by the phase verifier against the same
//       shipped `@modelcontextprotocol/server` this package builds on. The value
//       `negotiatedAppsExtension` reads is therefore composed by the CALLER in its own
//       per-request `_meta` and forwarded unauthenticated. This phase's own POSITIVE cell is the
//       proof: the "negotiating client" in `app-negotiation.test.ts` is a stock SDK client with
//       one declared capability member and nothing App-shaped about it, and it receives freshly
//       minted liveUrl tokens in its own JSON-RPC response body.
//   (b) WHAT IT THEREFORE DOES BUY, and it is not nothing. A host that cannot render an App does
//       not receive a document it would paint as text — an omitting caller is turned away above
//       the roster read and above the mint loop, so nothing is minted on that path. And a
//       2025-era caller cannot obtain this App at all, because there is no per-request
//       capabilities channel outside the modern era (408-02 D-G). Both are real, and both are
//       statements about CAPABILITY.
//   (c) WHAT IT DOES NOT BUY. It does not distinguish an Apps host from any other caller that
//       adds one `_meta` member to a `resources/read`. It separates cooperative clients from
//       omitting ones — never Apps hosts from model-driven callers.
//
// T-408-01, RE-ADJUDICATED 2026-09-01 — DISPOSITION: `accept`. It was `mitigate`, and 408-02
// reported it closed; that verdict is withdrawn here. The residual, stated plainly: a caller the
// operator granted `read` can obtain a live-view credential through this door. BOTH halves of the
// argument are recorded, because an acceptance that keeps only the comfortable half is the same
// over-claim in a new coat.
//   ACCEPTING REASONING (D-02's own, restated). Watching a run IS a read. Per-step decision
//   screenshots of the same browser already cross the read path as DURABLE artifacts, so live
//   frames expose the same pixels sooner rather than a new class of thing; the credential is
//   view-scoped and expires in five minutes (`LIVE_URL_TTL_MS`); and D-02 rejected a dedicated
//   live-view scope as "config friction guarding a channel `read` already exposes". Nothing this
//   gap round measured answers that rejection — it found the CLAIM wrong, not the boundary.
//   COUNTER-ARGUMENT (408-REVIEW.md CR-01, recorded rather than buried). The credential is NOT
//   strictly scope-equivalent to what a `read` caller already holds: no projected tool yields a
//   live pixel stream of a running browser, and the minted URL works from any browser on the
//   machine for its full five-minute TTL. That is a capability, not merely an artifact arriving
//   sooner, and the acceptance is made in full sight of it.
// The negative cell the verification asks for — a caller that merely DECLARES, asserting the
// policy intended rather than the one the gate happens to enforce — is 408-12's subject, and it
// cites this ruling.
//
// THE NEGOTIATION EVIDENCE IS MEASURED, NOT ASSUMED (RESEARCH Open Question 1 / assumption A3).
// The envelope member spelling below was measured on 2026-08-31 against a real
// `@modelcontextprotocol/client@2.0.0` over the shipped node handler — the living record is
// `src/__tests__/app-negotiation.test.ts`, which drives the wire and would red if the SDK moved
// it. The measurement also produced a fact worth stating plainly, because it decides who can see
// this App at all: the per-request capabilities envelope exists ONLY on the modern (2026-07-28)
// wire era. A client that connects with the SDK's default legacy `initialize` handshake sends no
// per-request capabilities, and a stateless per-request server instance never saw that handshake,
// so `getClientCapabilities()` holds nothing there either (the SDK says so itself: "per-request
// instances that never saw an initialize (stateless legacy) hold nothing, so gates refuse there").
// This gate therefore fails CLOSED for a 2025-era caller — no evidence of negotiation, no App —
// which is exactly what D-09 asks for: the App attaches only where the extension was negotiated,
// and every other host is served by the link-out that rides every carrier result.
//
// ONE CODEC, NO SECOND PARSER (T-396-08 / T-408-02). `parseAppUri` is the only thing in this
// package that reads a `ui://` address, and it defers the run-id question to the MINT OP'S OWN
// input contract rather than re-deriving path safety here. A local regex over the id would be a
// second, weaker reading of a string that names a directory.
//
// Protocol grounding. SEP-1730 puts extensions OUTSIDE every conformance tier — a host owes an
// extension nothing, which is exactly why the link-out rides every carrier result and why an App
// that never renders costs a caller no capability. SEP-2575 (the stateless protocol) is why the
// mint happens on the READ rather than once at registration: there is no session to hold a token
// in, so freshness is the cheap path rather than a feature. SEP-2567 removed per-connection
// variance from list endpoints, which is the other half of `{ list: undefined }` below — this
// template's absence from listings is a property of the SERVER, identical for every caller (no
// caller holds scopes since 432-20, D-12), and not a capability-conditional listing smuggled in
// through a resolver.
// SEP-2549's cache hints are declined for the same reason the mint is per-read: a cacheable App
// document would be a cacheable credential.

import { CLIENT_CAPABILITIES_META_KEY, ResourceTemplate } from '@modelcontextprotocol/server'
import type {
  ClientCapabilities,
  ReadResourceResult,
  ReadResourceTemplateCallback,
  RequestMetaEnvelope,
  ResourceMetadata,
  ServerContext,
  Variables,
} from '@modelcontextprotocol/server'
import {
  invokeFunction,
  FunctionNotBoundError,
  LiveViewUnavailableError,
  RUNS_EVENTS_FUNCTION_ID,
  RUNS_LIVE_URL_FUNCTION_ID,
  UnknownRunError,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import { handleRosterOf, RunsLiveUrlInputSchema } from '@vostride/agent-qa-schema'
import type {
  FunctionCaller,
  RunEventEnvelope,
  RunsLiveUrlResult,
} from '@vostride/agent-qa-schema'

import { renderAppWrapperPage } from './app-wrapper.js'
import type { AppWrapperMint } from './app-wrapper.js'
import { liveRunLinkOf } from './live-link.js'
import type { LiveLinkSupplier } from './live-link.js'

// Restated, not imported: ext-apps peer-depends on SDK v1, and this package ships the v2 split SDK.
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui'

/** The media type an App resource is served as. Restated locally for the reason above. */
export const APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

/** The published App address. ONE template, per run — the runId is the only variable. */
export const APP_RESOURCE_URI_TEMPLATE = 'ui://agent-qa/live-run/{runId}'

/**
 * The template EXPANDED for one concrete run (408 plan 03, D-05).
 *
 * WHY THIS IS A FUNCTION AND NOT A STRING EACH CALLER COMPOSES. `projection.ts` advertises the
 * TEMPLATE on a carrier tool's `_meta`, and a carrier RESULT advertises the concrete address of the
 * run it just named — two spellings of one address, in two files, that would be free to disagree
 * about the scheme, the namespace or the segment order. Expanding through the template constant
 * makes drift impossible: there is one place the address is written down and one rule for filling
 * it in.
 *
 * ENCODED WITH `encodeURIComponent`, which is the exact inverse of the `decodeURIComponent` the one
 * codec above applies — so `parseAppUri(appResourceUriFor(id)).runId === id` for every id, and an
 * address this package composes is one this package can read back.
 */
export function appResourceUriFor(runId: string): string {
  return APP_RESOURCE_URI_TEMPLATE.replace('{runId}', encodeURIComponent(runId))
}

/** The registered resource name. Prefixed like the tools, so one namespace reads as one server. */
export const APP_RESOURCE_NAME = 'agent_qa_live_run_app'

const APP_RESOURCE_TITLE = 'agent-qa live run'

// Authored prose about the SURFACE, not about any run — the same class of string as a tool's
// curated title, so it is not masked. Nothing interpolated here comes from a caller or from storage.
const APP_RESOURCE_DESCRIPTION =
  'The live view for one run, as an MCP App: a sandboxed page embedding the run\'s live preview '
  + 'for each member handle. Rendered fresh on every read.'

/** The `ui://` scheme and the two fixed path segments, spelled once for the one codec below. */
const APP_URI_PREFIX = 'ui://agent-qa/live-run/'

/**
 * The ONE parser of a `ui://` app address.
 *
 * TOTAL AND UNDECORATED: it answers the run id or `undefined`, and it never explains which clause
 * refused — the caller-facing sentence is the read handler's, phrased once.
 *
 * THE RUN ID IS JUDGED BY THE MINT OP'S OWN INPUT CONTRACT, not by a pattern this file invented.
 * `RunsLiveUrlInputSchema` carries `runIdSchema` — the codec that decides whether a string may name
 * this run's own directory, so an address carrying `..`, a path separator or a control character is
 * refused here by exactly the rule that refuses it everywhere else. Stated the other way round,
 * which is the honest reading: an app address is well-formed precisely when the op this read mints
 * through would accept the run it names, so the two can never disagree about one string.
 */
export function parseAppUri(href: string): { readonly runId: string } | undefined {
  if (!href.startsWith(APP_URI_PREFIX)) return undefined
  const tail = href.slice(APP_URI_PREFIX.length)
  if (tail === '') return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(tail)
  } catch {
    return undefined
  }
  const parsed = RunsLiveUrlInputSchema.safeParse({ runId: decoded })
  if (!parsed.success) return undefined
  return { runId: parsed.data.runId }
}

/**
 * The envelope member carrying the request's declared client capabilities.
 *
 * MEASURED, NOT GUESSED, and re-exported from the SDK rather than restated as a literal so a
 * spelling drift is a compile error instead of a gate that silently answers "never negotiated".
 * The measurement (2026-08-31, `src/__tests__/app-negotiation.test.ts`) drove a real
 * `@modelcontextprotocol/client@2.0.0` against `createAgentQaMcpNodeHandler` over a loopback
 * socket and read the resource-read context back out of the handler:
 *
 *   ctx.mcpReq.envelope['io.modelcontextprotocol/clientCapabilities'].extensions['io.modelcontextprotocol/ui']
 *
 * That cell is the living record — it asserts the path against the wire, so an SDK that moves the
 * member reds it rather than quietly turning this gate into a blanket refusal.
 */
export const APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY = CLIENT_CAPABILITIES_META_KEY

/**
 * The ONE member of the SDK's read context this module reads.
 *
 * Declared structurally rather than as `Pick<ServerContext, 'mcpReq'>` for a reason a cell feels
 * immediately: the SDK's context carries a dozen live functions, and a predicate whose input
 * cannot be written down without them is a predicate only the wire can test. `ServerContext` is
 * assignable to this, so the production call site still hands over the SDK's own object untouched.
 */
export interface AppReadContext {
  readonly mcpReq?: { readonly envelope?: Partial<RequestMetaEnvelope> }
}

/**
 * Did THIS request declare the MCP Apps extension?
 *
 * FAIL-CLOSED at every step: no context, no envelope, no capabilities member, no `extensions`
 * record, or an `extensions` record without our id all answer `false`. The question is "is there
 * evidence this caller negotiated the extension", and absence of evidence is not evidence — which
 * matters most for the case the measurement surfaced, where a 2025-era caller carries no envelope
 * at all and would otherwise be waved through by a predicate written as "not explicitly absent".
 *
 * WHAT FAILING CLOSED HERE DOES AND DOES NOT PROTECT (dated 2026-09-01, 408 gap round, road
 * `demote` — the full ruling is in this file's header). The predicate is still fail-closed AS A
 * PREDICATE, and every clause above is unchanged. What is CORRECTED is the reading that failing
 * closed here protects the credential. It does not. The value read below is composed by the
 * caller in its own per-request `_meta` and forwarded by the SDK unauthenticated
 * (`_inputRequestCapabilityView` returns it verbatim; `checkInboundEnvelope` checks shape only),
 * so a `false` answer means "this caller did not SAY it can render an App" — a host-capability
 * fact — and never "this caller is not authorized to hold a live-view credential". What bounds
 * the credential is `bindingStatus === 'bound'` and the local network controls D-13 keeps; the
 * scope check that once sat beside it is deleted (432-20, D-12). See header clause 5.
 *
 * `RequestMetaEnvelope` is an intentionally EMPTY augmentable type in the shipped d.mts, so the
 * envelope is read through one narrow cast at this single seam rather than by widening the SDK's
 * types somewhere a second reader would have to find.
 */
export function negotiatedAppsExtension(ctx: AppReadContext | undefined): boolean {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined
  if (envelope === undefined) return false
  const capabilities = envelope[APP_NEGOTIATION_CLIENT_CAPABILITIES_KEY] as
    | ClientCapabilities
    | undefined
  const extensions = capabilities?.extensions
  if (extensions === undefined) return false
  return Object.hasOwn(extensions, MCP_APPS_EXTENSION_ID)
}

/**
 * A read refused because the request never declared the Apps extension (clause 3 of the ruling
 * in this file's header; D-09, T-408-01).
 *
 * IT NAMES THE EXTENSION AND CARRIES NOTHING ELSE. The message is authored prose plus a constant
 * this repository owns, so there is nothing caller-supplied in it to mask and — the point of the
 * whole arm — nothing minted in it to leak, because it is thrown before the first mint.
 */
export class AppResourceNegotiationError extends Error {
  constructor() {
    super(
      `this resource is an MCP App: it is served only to a client that declared the `
      + `${MCP_APPS_EXTENSION_ID} extension in its capabilities`,
    )
    this.name = 'AppResourceNegotiationError'
  }
}

/** An address the one codec does not recognise. */
export class AppResourceUriError extends Error {
  constructor(detail: string) {
    super(`${detail} is not a canonical ui://agent-qa/live-run address`)
    this.name = 'AppResourceUriError'
  }
}

/**
 * A refusal from the App read that is NOT a run-liveness fact.
 *
 * Deliberately narrow: absence of a live session is rendered, never thrown (D-07), so anything that
 * reaches this class is a genuine failure of the read — a missing scope, an unknown op, a broken
 * composition — and it carries its message masked for the same reason `resources.ts`'s does.
 */
export class AppResourceReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppResourceReadError'
  }
}

/**
 * A document whose panes would span more than one origin (IN-02, T-408-26; added 2026-09-01).
 *
 * THE INVARIANT THIS SERVES USED TO BE AN ASSUMPTION. The `_meta.ui.csp` block below was derived
 * from `mints[0]` alone, which is correct today only because `runs.liveurl` reads
 * `liveView.origin()` once per invocation — a fact held in ANOTHER package, which nothing on that
 * line checked. A composition that ever minted across origins would have shipped a frame allowance
 * covering the first pane and blocking every other one: a blank inner frame, which is the exact
 * failure this milestone exists to remove, arriving silently.
 *
 * WHY REFUSAL RATHER THAN A WIDER ALLOWANCE. Naming every origin in `frameDomains` would keep the
 * document renderable, but it would also make the allowance a function of how many panes happened
 * to be minted — precisely the "never broader than the document needs" property T-408-05 pins.
 * This module's own reasoning is that the allow is as narrow as the document needs; a document that
 * needs two origins is a composition this server does not know how to serve narrowly, and saying so
 * is honest absence rather than a silent widening.
 *
 * ITS MESSAGE CARRIES NO CALLER TEXT AND NO CREDENTIAL. The origins are host-composed and
 * `originOf` returns an origin only — never the path and never the fragment the token lives in — so
 * there is nothing here to mask and nothing here to leak.
 */
export class AppResourceOriginSpanError extends Error {
  constructor(origins: readonly string[]) {
    super(
      `this App document would span ${origins.length} origins `
      + `(${[...origins].sort().join(', ')}) and one frame allowance covers one: refusing to serve `
      + `a document whose panes it could not all reach`,
    )
    this.name = 'AppResourceOriginSpanError'
  }
}

/** The host-bound `(registry, caller)` closure over `invokeFunction`. */
export type AppResourceInvoke = (opId: string, input: unknown) => Promise<unknown>

export interface AppResourceReadDeps {
  readonly invoke: AppResourceInvoke
  /** How CALLER text leaving this handler is masked. Required — see the header's channel split. */
  readonly maskText: (text: string) => string
  /**
   * Which dashboard this process is pointed at, for D-08's permanent link (408 plan 03).
   *
   * OPTIONAL, and its absence is a real posture rather than a gap: a composition that knows of no
   * dashboard renders the wrapper with NO anchor at all, which is what plan 01 shipped and what the
   * honest-absence law requires — a link to nothing is the dishonesty this milestone removes.
   *
   * THIS IS THE ONE SLOT WHOSE ABSENCE COSTS A PERSON SOMETHING, which is why it is wired rather
   * than left where plan 01 left it: the wrapper's `expired` and `unreachable-origin` states are
   * D-11's answers for "the embed cannot show you this", and both of them are supposed to hand a
   * person the browser instead. A wrapper reaching those states with no link is a dead end wearing
   * an honest sentence.
   */
  readonly liveLink?: LiveLinkSupplier
}

/**
 * True when a refusal is a statement about this host's LIVENESS rather than about the read.
 *
 * The three shapes a not-live composition can answer with, named by class rather than by message:
 * a host with no live-view port at all (`FunctionNotBoundError` from the binding check, or
 * `LiveViewUnavailableError` from the op when the port is bound but serves no origin), and a run
 * this host holds no session for (`UnknownRunError`). Each becomes the wrapper's honest not-live
 * document — never an error surface, and never a blank frame (D-07).
 */
function isNotLiveRefusal(error: unknown): boolean {
  return (
    error instanceof UnknownRunError
    || error instanceof LiveViewUnavailableError
    || error instanceof FunctionNotBoundError
  )
}

/**
 * The handle roster this run ANNOUNCED, read off its own first envelope.
 *
 * `runStarted` is seq 1 and carries the roster as an additive payload field (402-04 D-10), so one
 * envelope answers the whole question and the iterator is disposed immediately — a resource read
 * that drained a run's entire event log to learn two integers would be a second, far more expensive
 * answer to a question the first element already answers.
 *
 * Answers `undefined` rather than a default, so the CALLER decides what an unannounced roster
 * means; the read handler reads it as handle 0, the single-member case every non-suite run is.
 *
 * IT ALSO ANSWERS `[]`, AND THAT IS THE SAME DECISION (WR-05, 2026-09-01). `handleRosterOf` answers
 * `[]` for a `runStarted` that really announced `handles: []`, and `undefined` only when the field
 * is absent or malformed — two different bytes on the wire, one question for the caller. The read
 * handler collapses them at `rosterToMint` below: an announced-but-empty roster is a run that named
 * no members, not a run that ended, and `run-ended` is a claim about LIVENESS. Kept as two answers
 * HERE rather than defaulted away, because this function's contract is to report what the envelope
 * said; deciding what it means is the caller's job, and now there is exactly one place doing it.
 */
async function announcedRoster(
  invoke: AppResourceInvoke,
  runId: string,
): Promise<readonly number[] | undefined> {
  const stream = await invoke(RUNS_EVENTS_FUNCTION_ID, { runId })
  const iterable = stream as AsyncIterable<RunEventEnvelope> | undefined
  if (iterable === undefined || typeof iterable[Symbol.asyncIterator] !== 'function') {
    return undefined
  }
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done === true) return undefined
    return handleRosterOf(first.value)
  } finally {
    await iterator.return?.(undefined)
  }
}

/**
 * Build the App read.
 *
 * Exported so a cell can drive it without a server, and so the parse/mint/render behaviour is
 * observable independently of registration — the two halves fail in different directions.
 */
export function createAppResourceReadHandler(
  deps: AppResourceReadDeps,
): (uri: URL, variables: Variables, ctx: AppReadContext) => Promise<ReadResourceResult> {
  return async (
    uri: URL,
    _variables: Variables,
    ctx: AppReadContext,
  ): Promise<ReadResourceResult> => {
    // CLAUSE 3 OF THE HEADER'S RULING, AND IT IS THE FIRST LINE ON PURPOSE (D-09).
    // A RENDERING-CAPABILITY FILTER, NOT THE AUTHORIZATION CHECK (corrected 2026-09-01, 408 gap
    // round, road `demote`; T-408-01 re-adjudicated to `accept` — the ruling is in the header).
    // What this line asks is whether the caller SAID it can render an MCP App. A caller that did
    // not say so is turned away before anything below runs, so this path has no token to withhold
    // rather than a token it remembered not to print — and that ordering is still worth keeping.
    // It is not, however, an authorization check. Since 432-20 (D-12) no per-caller permission
    // exists: `registerAppResources` registered this template because the mint is `bound` in this
    // composition, and a composition without that never reaches this handler at all.
    if (!negotiatedAppsExtension(ctx)) throw new AppResourceNegotiationError()

    const parsed = parseAppUri(uri.href)
    if (parsed === undefined) {
      // The echoed address is caller-supplied text, so it is masked exactly as `resources.ts`
      // masks its own — this is the refusal channel, and the channel split is the point.
      throw new AppResourceUriError(deps.maskText(uri.href))
    }
    const { runId } = parsed

    let roster: readonly number[] | undefined
    let notLive = false
    try {
      roster = await announcedRoster(deps.invoke, runId)
    } catch (err) {
      if (!isNotLiveRefusal(err)) {
        throw new AppResourceReadError(
          deps.maskText(err instanceof Error ? err.message : String(err)),
        )
      }
      notLive = true
    }

    // WR-05 (2026-09-01, T-408-25): `undefined` AND `[]` resolve here, once, by name.
    // `roster ?? [0]` did not fire for `[]` — `??` tests nullishness, not emptiness — so a run whose
    // `runStarted` announced `handles: []` ran the mint loop ZERO times, produced no mints, and was
    // rendered `run-ended` by the count below for a run this host IS holding a live session for.
    // That is not a cosmetic error: under the promoted D-08 model the credentialled embed is one
    // bounded variant of a representation whose primary form is the permanent link, and `run-ended`
    // is how this document says the variant is unavailable. Withdrawing it on a false premise is the
    // same class of dishonesty as labelling a dead pane `live`.
    //
    // Both absences mean what the handler already documents as its default: the single member,
    // handle 0. A named local rather than an expression in the `for` header, because the point is
    // that three paths became two and a reader has to be able to SEE that.
    const rosterToMint = roster === undefined || roster.length === 0 ? [0] : roster

    const mints: AppWrapperMint[] = []
    if (!notLive) {
      for (const handle of rosterToMint) {
        // THE ONE INVOCATION WALL, once per handle (D-06). Fresh on EVERY read, which is D-10's
        // fresh-on-render for free: nothing is cached here, so there is no stale token to serve.
        let minted: RunsLiveUrlResult
        try {
          minted = (await deps.invoke(RUNS_LIVE_URL_FUNCTION_ID, {
            runId,
            handle,
          })) as RunsLiveUrlResult
        } catch (err) {
          if (!isNotLiveRefusal(err)) {
            throw new AppResourceReadError(
              deps.maskText(err instanceof Error ? err.message : String(err)),
            )
          }
          // One member of a suite can finish while the run continues, so a per-handle refusal
          // drops that PANE rather than the whole document. Zero surviving mints is the run-level
          // not-live case, decided below by counting rather than by a second flag.
          continue
        }
        mints.push({
          handle: minted.handle,
          liveUrl: minted.liveUrl,
          expiresAt: minted.expiresAt,
          streamKind: minted.stream.kind,
        })
      }
    }

    // D-08's link-out, composed from whatever base this composition was pointed at (408 plan 03).
    // The SAME composition every carrier result uses — `liveRunLinkOf` is the one place the address
    // is built — so the anchor inside the App and the line beside a tool result cannot name two
    // different pages for one run. With no base, the slot stays ABSENT rather than fabricated: the
    // wrapper renders no anchor at all for an absent link.
    const base = deps.liveLink?.dashboardBaseUrl()
    const permanentLink
      = base === undefined || base.trim() === '' ? undefined : liveRunLinkOf(base.trim(), runId)

    // IN-02 (2026-09-01, T-408-26). THE ALLOWANCE IS DERIVED FROM THE WHOLE DOCUMENT, and the
    // invariant it rests on is ASSERTED HERE rather than assumed to hold in another package. Every
    // mint's origin, distinct, in one set: a mint whose `liveUrl` this host cannot name as a URL
    // contributes nothing (the old `mints[0]`-only form behaved the same way, and that arm is
    // unchanged), and two identical origins contribute one entry, so a two-handle document names
    // its shared origin once rather than once per pane.
    //
    // POSTURE, RECORDED AS THE COMMENT THIS FILE'S CHOICE IS SUPPOSED TO CARRY: a document whose
    // panes would span origins is REFUSED, not served with a widened allowance. See
    // `AppResourceOriginSpanError` for the reasoning. Refused BEFORE the wrapper is composed, so
    // there is no half-honest document in existence on that path.
    const frameOrigins = [
      ...new Set(
        mints
          .map((mint) => originOf(mint.liveUrl))
          .filter((origin): origin is string => origin !== undefined),
      ),
    ]
    if (frameOrigins.length > 1) throw new AppResourceOriginSpanError(frameOrigins)
    const frameDomain = frameOrigins[0]

    const html = renderAppWrapperPage({
      runId,
      mints,
      permanentLink,
      runLive: mints.length > 0,
    })

    // NOT MASKED, and the inversion of `resources.ts`'s rule is the decision. That module masks
    // because its payload is STORED data reaching a caller through a handler nothing else masks;
    // this payload is a credential minted for this response, whose whole purpose is to be handed to
    // the host's iframe intact. A masked token is a broken embed, so masking here would be the
    // defect rather than the guard. The channel that DOES echo caller text — the refusals above —
    // is masked, and Plan 04's scan cell is the standing gate on every model-readable channel.
    return {
      contents: [
        {
          // Re-formatted through the codec's own vocabulary rather than echoed, so the address a
          // caller reads back is the canonical one.
          uri: `${APP_URI_PREFIX}${runId}`,
          mimeType: APP_RESOURCE_MIME_TYPE,
          text: html,
          // The host's default is `frame-src 'none'`, so an App that names no frame domain paints
          // a BLOCKED inner frame — the blank pane criterion 2 forbids (Pitfall 1). The allowed
          // origin is the minted link's OWN origin rather than a separately configured one, so the
          // allow can never be broader than the document needs (T-408-05). `frameDomain` is the ONE
          // distinct origin `frameOrigins` above resolved over EVERY mint (IN-02) — not `mints[0]`'s,
          // which was the same answer only by a fact held in another package.
          //
          // TWO ABSENCES, NOT ONE (corrected 2026-09-01, 408 gap round; `408-VERIFICATION.md` W-4 /
          // `408-REVIEW.md` WR-03). This comment used to read "with no mints there is no inner
          // frame, and the block is omitted rather than emitted empty", which describes only the
          // FIRST of two conditions that both reach `frameDomain === undefined`. They are different
          // questions with different served documents, and collapsing them told a reader about a
          // state the code does not produce:
          //   - `mints.length` asks whether there is anything to render at all. Zero mints means
          //     `runLive` is `false`, the wrapper emits no `<iframe data-app-live-frame>`, and the
          //     omitted `csp` block allows nothing because nothing needs allowing. Honest.
          //   - `frameOrigins[0]` is the SEPARATE question of whether any surviving mint yielded a
          //     parseable origin to put in `_meta.ui.csp`. With `mints.length > 0` and every
          //     `originOf(mint.liveUrl)` answering `undefined`, `runLive` is `true` — the document
          //     DOES emit the iframe and DOES assign `frame.src` — while the `csp` block is omitted,
          //     so a conformant host falls back to `frame-src 'none'` and the pane is blocked and
          //     blank. Not honest, and the sentence above never mentioned it.
          //   WHY NO SHIPPED PORT REACHES IT: `runs.liveurl` would have to answer a `liveUrl` that
          //   is not a parseable URL, and no shipped port does. The verifier measured this as
          //   unreachable and classified W-4 as a documentation finding rather than a gap; the
          //   wrapper's probe/timeout arm would in any case settle `unreachable-origin` with the
          //   permanent link rather than leave a blank pane under a progress claim, so SC2 survives
          //   even on the unreachable path.
          //
          // THE INVARIANT IS UNASSERTED, AND THAT IS A DATED DEFERRAL RATHER THAN A SILENCE
          // (2026-09-01, 408 gap round). "Every mint that survives into `runLive` has a nameable
          // origin" is asserted nowhere today — not here, not in `renderAppWrapperPage`, not in a
          // cell. It is the natural candidate and it is NOT taken in this round, because this round
          // is a gap-closure round whose whole reported gap is documentation integrity.
          //   THE RULE THAT MAKES THAT CONSISTENT, because the neighbouring round looks
          //   contradictory and a reader is entitled to it: THIS ROUND CHANGES WHAT THE SYSTEM
          //   SAYS, NEVER WHAT IT DOES. 408-16 task 1 does edit a runtime file — `config.ts` — but
          //   it only adds words to an error that was already being thrown on exactly the inputs it
          //   was already thrown on; no parse outcome moves in either direction and no input that
          //   succeeded now fails. Asserting the invariant here would add a NEW failure mode to a
          //   path that currently succeeds. Operator-facing error prose is in scope because it is
          //   prose; a new runtime invariant is out of scope because it is behaviour. That is the
          //   whole distinction, and it is what makes W-2 closable in this round and W-4's
          //   invariant half not.
          //
          // AND THE NEW PROSE CENSUS DOES NOT COVER THIS, which is the question the gap brief asks
          // by name. `__tests__/withdrawn-claim-census.test.ts` gates ONE withdrawn security claim
          // about the token channel, keyed on a channel cue bound to an exclusivity cue; W-4 is a
          // different species — a comment that CONFLATES two conditions rather than one that
          // over-claims a control — and widening that census to "any comment that conflates two
          // conditions" is not mechanizable, and a vocabulary that tried would red on honest prose,
          // which this round's own prohibition forbids.
          //
          // `connectDomains` NAMES THE SAME ONE ORIGIN, AND IT IS NOT OPTIONAL (408 plan 06 Task 2,
          // MEASURED 2026-08-31). ext-apps' shipped schema documents `connectDomains` as mapping to
          // `connect-src` with "empty or omitted -> no network connections (secure default)", and
          // 408-02 D-H gave this wrapper a no-cors probe of the frame's origin — because Chromium
          // fires `load` for a REFUSED connection, so `load` alone would label an error page `live`.
          // With only `frameDomains` declared, a conformant host serves the App under
          // `connect-src 'none'`, the probe is blocked before it leaves the document, and the
          // wrapper settles in `unreachable-origin` for a live view that is perfectly reachable —
          // measured in `app-host-harness.test.ts`, with Chromium naming the directive in its own
          // console. That is not a blank frame, but it is a lie with a sentence attached, which is
          // worse: it tells a person to go somewhere else while the pixels are right there.
          //
          // It is exactly as narrow as the frame allowance — the same single minted origin, never a
          // wildcard and never a second configured value — so the App can reach the one host it
          // embeds and nothing else.
          ...(frameDomain === undefined
            ? {}
            : {
                _meta: {
                  ui: { csp: { frameDomains: [frameDomain], connectDomains: [frameDomain] } },
                },
              }),
        },
      ],
    }
  }
}

/** The origin of a minted `liveUrl`, or `undefined` if it is not a URL this host can name. */
function originOf(liveUrl: string): string | undefined {
  try {
    return new URL(liveUrl).origin
  } catch {
    return undefined
  }
}

/**
 * The slice of `McpServer` this module uses.
 *
 * The same narrow structural type `resources.ts` declares, spelled with the SDK's own
 * `ResourceTemplate` / `ResourceMetadata` / `ReadResourceTemplateCallback` — so a cell can observe
 * the registration without assembling a protocol server while a real `McpServer` still satisfies
 * it. Read that module's note before narrowing any member here: a hand-narrowed config or a
 * `readonly` result array makes `McpServer` unassignable and the compiler names the wrong cause.
 *
 * THE READ CALLBACK IS THE SDK'S OWN `ReadResourceTemplateCallback` AND NOT A LOCAL NARROWING, for
 * the reason 408 plan 02 needed a third argument at all: the negotiation evidence arrives in the
 * SDK's read CONTEXT, so a slice that spelled the callback `(uri) => …` would have declared the
 * one parameter the gate reads out of existence.
 */
export interface AppResourceRegistrar {
  registerResource(
    name: string,
    template: ResourceTemplate,
    config: ResourceMetadata,
    read: ReadResourceTemplateCallback,
  ): unknown
}

/** Exactly what this module needs from the host — the same record `catalog.ts` already holds. */
export interface AppResourceDeps {
  readonly registry: FunctionRegistry
  readonly caller: FunctionCaller
  readonly maskText: (text: string) => string
  /** D-08's base supplier, passed straight through to the read. See {@link AppResourceReadDeps}. */
  readonly liveLink?: LiveLinkSupplier
}

/**
 * Register the App template when this composition can honestly serve it, and answer what it
 * registered.
 *
 * Returns the registered template URIs rather than nothing, for `resources.ts`'s reason: "registered
 * none" and "registered one" are the two halves of the claim, and a caller that had to inspect a
 * server to tell them apart could only ever test one of them.
 *
 * TWO CONDITIONS, BOTH READ OFF THE REGISTRY'S OWN DECLARATIONS (D-02/D-03), AND NEITHER ABOUT THE
 * CALLER (432-20, D-12 deleted the third, a `visibleToCaller` scope check):
 *
 *  1. Both ops this surface reads through — the mint and the roster read — are declared here. A
 *     composition that registered neither has no App to offer.
 *  2. The mint is BOUND in this composition. This is D-03's floor made structural: the standalone
 *     `agent-qa mcp` process composes no `liveView` port, so its `runs.liveurl` is declared-and-
 *     unbound and every mint there would refuse by name. Registering an App on that host would
 *     advertise an address whose every read is honestly empty — so it registers nothing at all,
 *     and the link-out is that host's whole answer. On a co-hosted composition the same three
 *     lines register it, by composition rather than by configuration.
 *
 * A composition that fails any of them gets NO template and NO error — the same answer `catalog.ts`
 * gives a tool whose op is missing, because refusing to build would take an entire MCP connection
 * down over one unavailable capability.
 */
export function registerAppResources(
  server: AppResourceRegistrar,
  deps: AppResourceDeps,
): readonly string[] {
  const declared = deps.registry.list(deps.caller)
  const mint = declared.find((candidate) => candidate.id === RUNS_LIVE_URL_FUNCTION_ID)
  const roster = declared.find((candidate) => candidate.id === RUNS_EVENTS_FUNCTION_ID)
  if (mint === undefined || roster === undefined) return []
  if (mint.bindingStatus !== 'bound') return []

  const read = createAppResourceReadHandler({
    // The wall, bound once: every mint crosses `invokeFunction` with this host's registry and this
    // caller, so input validation and the binding check run exactly as they do for a tool call.
    // There is no store, no cache and no second data path.
    invoke: (opId, input) => invokeFunction(deps.registry, opId, input, deps.caller),
    maskText: deps.maskText,
    // Absent stays ABSENT rather than becoming a present `undefined` supplier: the house rule for
    // an optional member, and the two are the same posture to the read either way.
    ...(deps.liveLink === undefined ? {} : { liveLink: deps.liveLink }),
  })

  server.registerResource(
    APP_RESOURCE_NAME,
    // `list: undefined` is REQUIRED to be spelled out by the SDK, and here the explicit absence is
    // load-bearing rather than merely honest: an unlisted template cannot be reached by
    // enumeration, so no model walking `resources/list` can discover an address whose read mints a
    // credential (Pitfall 2). Enumerating every watchable run is a listing this surface does not
    // offer, and this is the line that says so.
    new ResourceTemplate(APP_RESOURCE_URI_TEMPLATE, { list: undefined }),
    {
      title: APP_RESOURCE_TITLE,
      description: APP_RESOURCE_DESCRIPTION,
      mimeType: APP_RESOURCE_MIME_TYPE,
    },
    read,
  )

  return [APP_RESOURCE_URI_TEMPLATE]
}
