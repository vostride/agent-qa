// Fails closed: a member-scoped envelope with no usable `testIndex` reaches no handle.

import { RUN_EVENT_TYPES, type RunEventEnvelope, type RunEventType } from './bus-events'

// `run` always passes a handle filter, so every subscriber learns the run ended.
export type RunEventScope = 'run' | 'member' | 'member-when-addressed'

// Read off the payload types: a required `testIndex` makes a type member-scoped.
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

// The classification decides first, so a run-scoped envelope carrying a `testIndex` still passes.
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

// Number(raw) accepts ' 7 ', '0x7', '1e1', '' (as 0) and '-0'; only the canonical form is a handle.
export function parseHandleParam(raw: string | null | undefined): HandleParamParse {
  if (raw === null || raw === undefined) return { kind: 'absent' }
  if (!CANONICAL_HANDLE.test(raw)) return { kind: 'invalid' }
  const index = Number(raw)
  if (!Number.isSafeInteger(index)) return { kind: 'invalid' }
  return { kind: 'handle', index }
}

// Absent means the run announced no roster, which differs from an empty one.
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
