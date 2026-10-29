// Handle identity and the per-handle stream filter.
//
// A HANDLE IS DERIVED ADDRESSING, NOT A NEW IDENTIFIER. A parallel run presents ONE run id
// and N attachable per-member handles, and the identity a handle is spelled from is one the
// payloads already carry: `testIndex`, bound at `createMemberEventSink` construction. Nothing is
// minted here and nothing is added to the frozen envelope `{ seq, ts, runId, type, payload }` —
// this module only says, for each event type, WHICH of the two things an envelope addresses.
//
// THE CLASSIFICATION IS TOTAL AND POSITIVE, AND ITS TOTALITY IS STRUCTURAL. `RUN_EVENT_SCOPE` is
// declared `satisfies Record<RunEventType, RunEventScope>` over the frozen `RUN_EVENT_TYPES`, so a
// type appended to that list without a classification is a COMPILE error and a key that is not a
// member of it is an excess-property error. There is deliberately no default branch, no `??` and
// no "everything else is run-scoped" arm: a fall-through would silently publish a future
// member-scoped event to every handle, which is the exact cross-handle disclosure this filter
// exists to prevent.
//
// WHY A THIRD SCOPE VALUE. The plan named two — member and run — and reading `HookStartedPayload`
// at implementation time showed that hooks are neither. `testIndex` on that payload is OPTIONAL,
// and `hooks/orchestrator.ts:buildStartedPayload` spreads it only when the hook's identity carries
// one: a suite-level `setup` hook names no member, a per-test hook names exactly one. Scope is
// therefore a property of the INSTANCE for hooks, and the honest classification says so
// (`member-when-addressed`) rather than picking whichever of the two answers is wrong less often.
// Forcing hooks into `run` would leak every member's hook output to every handle; forcing them
// into `member` would drop suite-level hooks out of every handle's stream, including the handle
// of the member the hook was setting up for.
//
// THE FILTER FAILS CLOSED. A member-scoped envelope carrying no usable `testIndex` is a defect,
// and this predicate answers `false` for every handle rather than `true` for every handle. A
// defect that reaches nobody is a bug; a defect that reaches everybody is a disclosure. The
// unfiltered stream (no `handle` parameter) still carries it, which is where such an envelope
// stays visible to whoever can debug it.

import { RUN_EVENT_TYPES, type RunEventEnvelope, type RunEventType } from './bus-events'

/**
 * What an envelope addresses.
 *
 * - `run` — the whole run. ALWAYS passes a handle filter: a handle subscriber still has to
 *   learn that the run ended, what the verdict was, and that the process is alive.
 * - `member` — exactly one member, named by a REQUIRED `payload.testIndex`.
 * - `member-when-addressed` — one member when the payload names it, the run when it does not.
 */
export type RunEventScope = 'run' | 'member' | 'member-when-addressed'

/**
 * EVERY event type's scope, stated once.
 *
 * The rationale per group, so a later reader can check the reasoning rather than the verdict:
 *
 * - **Run lifecycle / diagnostics / liveness** (`runStarted`, `runFinished`, `verdict`,
 *   `runWarning`, `runError`, `heartbeat`) — D-14's own list. `runStarted` joins it because it is
 *   the run's header AND the roster announcement, so a handle subscriber must receive it to learn
 *   which handles exist at all.
 * - **Member lifecycle / step / evidence** (`testStarted`, `testFinished`, `stepStarted`,
 *   `stepFinalized`, `subActionRecorded`, `testRetryScheduled`) — every one of these payload types
 *   declares `testIndex: number` REQUIRED, and the sink binds it at construction. The
 *   classification is read off the payload types, not chosen.
 * - **Hooks** (`hookStarted`, `hookFinished`) — see the header note above.
 * - **The six post-run chip events** — run-scoped by nature: `ChipEventPayload` is
 *   `{ runId, error?, willRetry? }`. There is no member producer and no field that could name one.
 *   SIX since 404 D-02, not nine: the three never-emitted names for the third chain
 *   member were removed from the frozen vocabulary, and this table lost the same three keys.
 */
export const RUN_EVENT_SCOPE = {
  // Run lifecycle
  runStarted: 'run',
  runFinished: 'run',
  // Verdict
  verdict: 'run',
  // Diagnostics
  runWarning: 'run',
  runError: 'run',
  // Liveness
  heartbeat: 'run',
  // Member-test lifecycle
  testStarted: 'member',
  testFinished: 'member',
  // Step lifecycle
  stepStarted: 'member',
  stepFinalized: 'member',
  // Sub-action evidence tick
  subActionRecorded: 'member',
  // Per-member attempt reset
  testRetryScheduled: 'member',
  // Hook lifecycle — scope is a property of the instance (see header)
  hookStarted: 'member-when-addressed',
  hookFinished: 'member-when-addressed',
  // Post-processing / status chips
  analysisStarted: 'run',
  analysisCompleted: 'run',
  analysisFailed: 'run',
  curationStarted: 'run',
  curationCompleted: 'run',
  curationFailed: 'run',
} as const satisfies Record<RunEventType, RunEventScope>

/** The frozen list, re-exported here so a consumer walking the table has the roster beside it. */
export const RUN_EVENT_SCOPE_TYPES: readonly RunEventType[] = RUN_EVENT_TYPES

/**
 * The member an envelope names, or nothing.
 *
 * The ONE place a payload is asked which member it belongs to. A `testIndex` that is not a
 * non-negative safe integer is treated as absent rather than coerced — a filter that coerced
 * `'2'` to `2` would let a producer bug decide which reader sees which member's data.
 */
export function memberIndexOf(envelope: RunEventEnvelope): number | undefined {
  const value = (envelope.payload as { testIndex?: unknown }).testIndex
  if (typeof value !== 'number') return undefined
  if (!Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

/**
 * D-14's filter: does this envelope belong on the stream of handle `handleIndex`?
 *
 * The ONE spelling of run-scoped-ness in the product. The run service's SSE route imports this
 * rather than re-deriving it, so there is no second place the answer could drift.
 *
 * Order matters: the CLASSIFICATION decides first. A run-scoped envelope passes even if its
 * payload happens to carry a `testIndex` — otherwise a run-scoped event that grew that field
 * tomorrow would silently disappear from every other handle's stream, and D-14's guarantee that a
 * handle subscriber learns the run ended would quietly stop holding.
 */
export function passesHandleFilter(envelope: RunEventEnvelope, handleIndex: number): boolean {
  const scope: RunEventScope | undefined = RUN_EVENT_SCOPE[envelope.type]
  if (scope === 'run') return true
  const memberIndex = memberIndexOf(envelope)
  if (memberIndex === undefined) {
    // Addressed-when-named hooks with no member are the run's; anything else member-scoped that
    // lost its identity — including an envelope whose `type` this build does not know — reaches
    // no handle. Fail closed.
    return scope === 'member-when-addressed'
  }
  return memberIndex === handleIndex
}

/** The separator in the composite handle spelling. One character, stated once. */
export const HANDLE_ID_SEPARATOR = '#'

/**
 * The composite string spelling of a handle, for surfaces that need ONE id (a URL fragment, a
 * map key, a log line). The wire parameter is the bare integer (`?handle=2`) — this is the
 * convenience spelling, not a second identity: both are derived from the same `runId` +
 * `testIndex` pair and neither is minted.
 */
export function handleId(runId: string, testIndex: number): string {
  return `${runId}${HANDLE_ID_SEPARATOR}${String(testIndex)}`
}

/**
 * Parse a composite handle id, or nothing.
 *
 * Splits on the LAST separator so a run id that itself contains one still round-trips, and
 * refuses rather than guessing when either half is malformed.
 */
export function parseHandleId(value: string): { runId: string; testIndex: number } | undefined {
  const at = value.lastIndexOf(HANDLE_ID_SEPARATOR)
  if (at <= 0) return undefined
  const runId = value.slice(0, at)
  const parsed = parseHandleParam(value.slice(at + 1))
  if (parsed.kind !== 'handle') return undefined
  return { runId, testIndex: parsed.index }
}

/**
 * The outcome of reading a `handle` request parameter. THREE ARMS, and no permissive one: there
 * is no value of this type meaning "it was malformed, serve them the firehose anyway".
 */
export type HandleParamParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'handle'; readonly index: number }

/** Canonical non-negative decimal integers only — no sign, no leading zero, no exponent. */
const CANONICAL_HANDLE = /^(?:0|[1-9][0-9]*)$/

/**
 * Read the `handle` parameter off an untrusted request.
 *
 * DELIBERATELY NOT `Number(raw)`: that accepts `'  7 '`, `'0x7'`, `'1e1'`, `''` (→ 0) and `'-0'`,
 * so a caller could reach a member through several spellings and an empty parameter would silently
 * become handle 0. The canonical form is the only accepted form.
 */
export function parseHandleParam(raw: string | null | undefined): HandleParamParse {
  if (raw === null || raw === undefined) return { kind: 'absent' }
  if (!CANONICAL_HANDLE.test(raw)) return { kind: 'invalid' }
  const index = Number(raw)
  if (!Number.isSafeInteger(index)) return { kind: 'invalid' }
  return { kind: 'handle', index }
}

/**
 * The handle roster a run announced, read off its `runStarted` envelope.
 *
 * The roster rides `runStarted.payload.handles` — an ADDITIVE payload field, never a new event
 * type (the `RUN_EVENT_TYPES` list is frozen/append-only and a second event vocabulary on the wire
 * is forbidden). Answers `undefined` when a run announced none, which a caller reads as "this run
 * cannot answer a per-handle question" rather than as an empty roster.
 *
 * (The wording above deliberately avoids the two-word sequence a raw source scan mistakes for an
 * import specifier: `validate:arch` reads every `<keyword> '…'` in this file as a declared
 * dependency, and a JSDoc sentence that happens to end in one is reported as a phantom external
 * dep. Measured live in 402-04; the same class of false positive 402-01 hit on a census.)
 */
export function handleRosterOf(envelope: RunEventEnvelope): readonly number[] | undefined {
  if (envelope.type !== 'runStarted') return undefined
  const value = (envelope.payload as { handles?: unknown }).handles
  if (!Array.isArray(value)) return undefined
  const handles: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) return undefined
    handles.push(entry)
  }
  return handles
}
