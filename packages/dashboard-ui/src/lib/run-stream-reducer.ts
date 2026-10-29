import type {
  MemberTestOutcome,
  RecordedRetrievalRung,
  RunEventEnvelope,
  RunStartedPayload,
  RunStatus,
  RunWarningPayload,
  StepFinalizedPayload,
  StepStartedPayload,
  TestFinishedPayload,
  TestRetryScheduledPayload,
  TestStartedPayload,
  VerdictPayload,
  VerifierVerdict,
} from '@vostride/agent-qa-schema'

// Rows copy payload fields one by one, as a spread leaks planner fields; `now` is the only clock.

// The step vocabulary in lifecycle order, compatible with `lib/status.ts`.
export const STEP_STATUSES = [
  'pending',
  'running',
  'passed',
  'failed',
  'healed',
  'skipped',
  'cancelled',
] as const

export type StepStatus = (typeof STEP_STATUSES)[number]

const TERMINAL_STEP_STATUSES: readonly StepStatus[] = ['passed', 'failed', 'healed', 'skipped', 'cancelled']

// Rows have no slot for reasoning content, and `ticks` is a count, never a phase.
export interface LiveStepRow {
  testIndex: number
  stepIndex: number
  status: StepStatus
  // From `stepStarted`, else the masked `testStarted.stepTexts` entry, else empty and not drawn.
  text: string
  /** The `ts` of the `stepStarted` envelope — the page's elapsed-time origin. */
  startedAt?: number
  /** How many sub-actions this step has recorded. Motion and a number; nothing more. */
  ticks: number
  /** The `ts` of the most recent tick, so the page can restart its motion on each one. */
  lastTickAt?: number
  durationMs?: number
  /** The bus seq that created this row — the total order the page renders in. */
  createdSeq: number
}

/** One member test of the run, as the live page knows it. */
export interface MemberRow {
  testIndex: number
  name: string
  totalSteps?: number
  outcome?: MemberTestOutcome
  durationMs?: number
  /**
   * The honest word for a member whose stream carried no step at all — see
   * {@link DID_NOT_RUN_NOTE}. Absent for every member that produced one.
   */
  note?: string
  /** Whether any `stepStarted` for this member was ever observed. Decides {@link DID_NOT_RUN_NOTE}. */
  sawStepStarted: boolean
}

// A member stream can begin with a terminal event, so a member with no steps says it did not run.
export const DID_NOT_RUN_NOTE = 'did not run'

/** A `runWarning`/`runError` reduced to what a viewer can act on. The `context` map is dropped. */
export interface RunStreamNotice {
  code: string
  message: string
}

/** The inclusive seq range a replay floor cost this viewer. See {@link markGap}. */
export interface RunStreamGap {
  from: number
  to: number
}

export interface RunStreamState {
  /**
   * Members by `testIndex`. Integer-like keys iterate in ascending numeric order in every JS
   * engine, so `Object.values` is member order without a second sort.
   */
  members: Readonly<Record<number, MemberRow>>
  /** Every step row, in bus seq order — never arrival order and never `ts` order. */
  steps: readonly LiveStepRow[]
  /** The run's attachable handle roster, as `runStarted` announced it. Undefined if it announced none. */
  handles?: readonly number[]
  /** The injected `now` at which the most recent envelope was folded. Undefined before the first. */
  lastEnvelopeAt?: number
  /** The HIGHEST seq observed — the resume point a reattach must carry. */
  lastSeq: number
  verdict?: RunStatus
  terminal: boolean
  notices: readonly RunStreamNotice[]
  gap?: RunStreamGap
  // Run-constant, so the first carrying frame wins; absent, never nulled, until one arrives.
  retrievalRung?: RecordedRetrievalRung
}

export function createInitialRunStreamState(): RunStreamState {
  return {
    members: {},
    steps: [],
    handles: undefined,
    lastEnvelopeAt: undefined,
    lastSeq: 0,
    verdict: undefined,
    terminal: false,
    notices: [],
    gap: undefined,
  }
}

// `status` wins if known, then the heal flag before the verdict, as a healed step's verdict passes.
export function stepStatusOf(payload: StepFinalizedPayload): StepStatus {
  const declared = payload.status
  if (declared !== undefined && (TERMINAL_STEP_STATUSES as readonly string[]).includes(declared)) {
    return declared
  }
  if (payload.selfHealOccurred === true) return 'healed'
  if ((payload.verifierVerdict as VerifierVerdict | undefined) === undefined) {
    // A finalize with no verdict object at all is a malformed producer. `failed` is the honest
    // answer: an absent verdict is not a pass.
    return 'failed'
  }
  return payload.verifierVerdict.pass ? 'passed' : 'failed'
}

// After a floor, re-attach at `earliestAvailableSeq - 1`; a gap is never cleared or overwritten.
export function markGap(state: RunStreamState, lastSeen: number, earliestAvailableSeq: number): RunStreamState {
  if (state.gap !== undefined) return state
  const from = lastSeen + 1
  const to = earliestAvailableSeq - 1
  if (to < from) return state
  return { ...state, gap: { from, to } }
}

// --- the fold ---------------------------------------------------------------

function memberFor(state: RunStreamState, testIndex: number): MemberRow {
  return state.members[testIndex] ?? { testIndex, name: '', sawStepStarted: false }
}

function withMember(state: RunStreamState, member: MemberRow): Readonly<Record<number, MemberRow>> {
  return { ...state.members, [member.testIndex]: member }
}

/**
 * Insert a row at its seq position. Two events can share a `ts` — the bus stamps wall-clock time
 * and two members can start a step in the same millisecond — and a stream that was resumed or
 * multiplexed can deliver a lower seq after a higher one. `seq` is the bus's total order and the
 * only one this page renders in.
 */
function insertBySeq(rows: readonly LiveStepRow[], row: LiveStepRow): LiveStepRow[] {
  const next = [...rows]
  let at = next.length
  while (at > 0 && next[at - 1]!.createdSeq > row.createdSeq) at -= 1
  next.splice(at, 0, row)
  return next
}

function replaceRow(rows: readonly LiveStepRow[], index: number, row: LiveStepRow): LiveStepRow[] {
  const next = [...rows]
  next[index] = row
  return next
}

const rowIndexOf = (rows: readonly LiveStepRow[], testIndex: number, stepIndex: number): number =>
  rows.findIndex((row) => row.testIndex === testIndex && row.stepIndex === stepIndex)

// The default arm moves only `lastSeq` and `lastEnvelopeAt`; chips belong to the durable surface.
export function reduceRunStream(state: RunStreamState, envelope: RunEventEnvelope, now: number): RunStreamState {
  // Every envelope is activity, whatever it says — that is what makes the bus `heartbeat` count.
  // `lastSeq` takes the HIGHEST seq seen rather than the latest: a resume point that walked
  // backward on an out-of-order delivery would re-open a gap the viewer had already been served.
  const base: RunStreamState = {
    ...state,
    lastEnvelopeAt: now,
    lastSeq: Math.max(state.lastSeq, envelope.seq),
  }

  // After `runFinished` nothing reopens a row, but seq keeps counting so a reattach resumes right.
  if (state.terminal) return base

  switch (envelope.type) {
    case 'runStarted': {
      const payload = envelope.payload as RunStartedPayload
      // An absent roster is not an empty one: a run that announced none simply cannot answer a
      // per-handle question, which is different from answering "no handles".
      return { ...base, handles: payload.handles === undefined ? undefined : [...payload.handles] }
    }

    case 'testStarted': {
      const payload = envelope.payload as TestStartedPayload
      const existing = memberFor(base, payload.testIndex)
      const member: MemberRow = {
        ...existing,
        testIndex: payload.testIndex,
        name: payload.name,
        totalSteps: payload.totalSteps,
      }
      // Untrusted JSON: only string entries are read, and rows stay capped at `totalSteps`.
      const stepTexts: unknown = payload.stepTexts
      const pendingText = (stepIndex: number): string => {
        if (!Array.isArray(stepTexts)) return ''
        const entry: unknown = stepTexts[stepIndex]
        return typeof entry === 'string' ? entry : ''
      }
      let steps = base.steps
      if (payload.totalSteps !== undefined) {
        for (let stepIndex = 0; stepIndex < payload.totalSteps; stepIndex += 1) {
          if (rowIndexOf(steps, payload.testIndex, stepIndex) >= 0) continue
          steps = insertBySeq(steps, {
            testIndex: payload.testIndex,
            stepIndex,
            status: 'pending',
            text: pendingText(stepIndex),
            ticks: 0,
            createdSeq: envelope.seq,
          })
        }
      }
      return { ...base, members: withMember(base, member), steps }
    }

    case 'stepStarted': {
      const payload = envelope.payload as StepStartedPayload
      const member: MemberRow = { ...memberFor(base, payload.testIndex), testIndex: payload.testIndex, sawStepStarted: true }
      const at = rowIndexOf(base.steps, payload.testIndex, payload.stepIndex)
      // A repeated `stepStarted` for the same coordinates is a retry attempt: the row goes back to
      // `running` with its tick count reset, because those ticks belong to the previous attempt.
      const row: LiveStepRow = {
        testIndex: payload.testIndex,
        stepIndex: payload.stepIndex,
        status: 'running',
        text: payload.stepText,
        startedAt: envelope.ts,
        ticks: 0,
        lastTickAt: undefined,
        createdSeq: at >= 0 ? base.steps[at]!.createdSeq : envelope.seq,
      }
      return {
        ...base,
        members: withMember(base, member),
        steps: at >= 0 ? replaceRow(base.steps, at, row) : insertBySeq(base.steps, row),
      }
    }

    case 'stepFinalized': {
      const payload = envelope.payload as StepFinalizedPayload
      const status = stepStatusOf(payload)
      const at = rowIndexOf(base.steps, payload.testIndex, payload.stepIndex)
      // ONE NAMED FIELD, READ BEFORE THE ARMS SPLIT. Spelled here rather than inside each return
      // so the resumed-stream path (no prior `stepStarted`) cannot drift out of the rule — that
      // is the very path a reconnecting live page lands on. `??` is what makes the first carrying
      // frame win: an already-recorded rung is never reconsidered.
      const retrievalRung = base.retrievalRung ?? payload.retrievalRung
      const rung = retrievalRung === undefined ? {} : { retrievalRung }
      if (at < 0) {
        // A finalize with no prior start — a resumed stream can land between the two. The row is
        // created directly in its final status rather than being invented as `running` first.
        return {
          ...base,
          ...rung,
          members: withMember(base, { ...memberFor(base, payload.testIndex), testIndex: payload.testIndex }),
          steps: insertBySeq(base.steps, {
            testIndex: payload.testIndex,
            stepIndex: payload.stepIndex,
            status,
            text: '',
            ticks: 0,
            durationMs: payload.durationMs,
            createdSeq: envelope.seq,
          }),
        }
      }
      const previous = base.steps[at]!
      // The tick count survives finalize: it is the step's history, not its animation.
      return {
        ...base,
        ...rung,
        steps: replaceRow(base.steps, at, { ...previous, status, durationMs: payload.durationMs }),
      }
    }

    case 'subActionRecorded': {
      // Only the coordinates are destructured, so nothing else in the payload can reach a row.
      const { testIndex, stepIndex } = envelope.payload as { testIndex: number; stepIndex: number }
      const at = rowIndexOf(base.steps, testIndex, stepIndex)
      if (at < 0) return base
      const previous = base.steps[at]!
      return {
        ...base,
        steps: replaceRow(base.steps, at, { ...previous, ticks: previous.ticks + 1, lastTickAt: envelope.ts }),
      }
    }

    case 'testFinished': {
      const payload = envelope.payload as TestFinishedPayload
      const existing = memberFor(base, payload.testIndex)
      const member: MemberRow = {
        ...existing,
        testIndex: payload.testIndex,
        outcome: payload.outcome,
        durationMs: payload.durationMs,
        note: existing.sawStepStarted ? undefined : DID_NOT_RUN_NOTE,
      }
      // Rows pre-populated from `totalSteps` for a member that never started one are `skipped`,
      // not left `pending` under a finished member — a pending row on a finished test reads as
      // "still coming", which is the one thing it is not.
      const steps = existing.sawStepStarted
        ? base.steps
        : base.steps.map((row) =>
            row.testIndex === payload.testIndex && row.status === 'pending'
              ? { ...row, status: 'skipped' as StepStatus }
              : row,
          )
      return { ...base, members: withMember(base, member), steps }
    }

    case 'testRetryScheduled': {
      const payload = envelope.payload as TestRetryScheduledPayload
      // The attempt's accumulated rows are cleared rather than appended to: the next attempt
      // re-emits the same `(testIndex, stepIndex)` coordinates, and a subscriber that kept both
      // would double-count a run that in fact ran the step once more.
      return {
        ...base,
        members: withMember(base, { ...memberFor(base, payload.testIndex), testIndex: payload.testIndex, outcome: undefined, note: undefined }),
        steps: base.steps.map((row) =>
          row.testIndex === payload.testIndex
            ? { ...row, status: 'pending' as StepStatus, ticks: 0, lastTickAt: undefined, startedAt: undefined, durationMs: undefined }
            : row,
        ),
      }
    }

    case 'verdict': {
      // The FIRST verdict is the run's verdict. A second one is a producer defect, and taking it
      // would let a page show two different endings for one run.
      if (base.verdict !== undefined) return base
      return { ...base, verdict: (envelope.payload as VerdictPayload).verdict }
    }

    case 'runFinished':
      return { ...base, terminal: true }

    case 'runWarning':
    case 'runError': {
      const payload = envelope.payload as RunWarningPayload
      // The code and the message, and nothing else. `context` is a free-form map the producer
      // filled; it is masked at the sink but it is not content this surface has a place for.
      return { ...base, notices: [...base.notices, { code: payload.code, message: payload.message }] }
    }

    default:
      return base
  }
}
