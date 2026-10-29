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

/** The step vocabulary HNST-02 fixes, in lifecycle order. Compatible with `lib/status.ts`. */
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

/**
 * One step of one member, as the live page is allowed to know it.
 *
 * THE FIELDS THAT ARE NOT HERE ARE THE POINT. There is no slot for a plan, an intended action, a
 * candidate target, an action result or a verifier's prose — the five payload fields the bus
 * carries and this surface refuses (D-10). This file does not NAME those fields anywhere, in code
 * or in prose: the reducer destructures only the two coordinates it keeps, so there is no
 * spelling of them here for a later edit to reach for. What a viewer gets from a running step is that it is
 * running, what it is called, how long it has been going and how many sub-actions it has recorded.
 * The step's reasoning belongs to the run record, which is durable, complete, and one click away.
 *
 * `ticks` is a COUNT, never a phase. The animation it drives is indeterminate on purpose: a label
 * derived from tick timing would be a guess about what the agent is doing between two events, and a
 * guess rendered as fact is the provisional content this phase exists to stop showing.
 */
/**
 * One step row on the LIVE page, folded from the run stream.
 *
 * NAMED `LiveStepRow` SINCE 405-11, and the rename is the whole point of the name: the durable
 * page's v1 row carried the same short name in the API module, so the two shapes were one grep
 * apart from each other for anyone auditing which of them was retired. That one is gone; this one
 * has a live producer and keeps a name that says which page it belongs to.
 */
export interface LiveStepRow {
  testIndex: number
  stepIndex: number
  status: StepStatus
  /**
   * The step's own text, verbatim from `stepStarted`. Before the step starts, the masked text
   * `testStarted.stepTexts` carried. Empty when neither is known, and then the row is not drawn
   * (428-30, G-428-2).
   */
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

/**
 * What a member with no steps renders as. A thin handle stream can BEGIN with a terminal event —
 * 402's `?handle=1` observation — and blank rows under a green tick would read as "it passed
 * everything", which is a lie about a member that never started.
 */
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
  /**
   * The retrieval rung this run was served on, as the FIRST `stepFinalized` frame carrying it
   * said (407-10 · D-14).
   *
   * RUN-CONSTANT, SO THE FIRST FRAME WINS. The rung describes the HOST'S ladder at the moment
   * this run was served — not how any one step's brief was ranked — so every frame that carries
   * it carries the same value. Folding "last write wins" would be indistinguishable today and
   * would turn any future per-step variation into a header that flickers between two accounts of
   * one machine, and then disagrees with the durable banner run detail paints from the same
   * evidence.
   *
   * ABSENT, NEVER NULLED, BEFORE THE FIRST CARRYING FRAME. "Not yet known" is the missing key —
   * which is what lets the page render no element at all rather than a banner claiming a rung
   * nobody has stated. A pre-407 run and a run with no knowledge reader bound (D-16) never leave
   * this state.
   */
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

/**
 * HNST-02's status resolution for one finalized step.
 *
 * THE ORDER IS LOAD-BEARING. A healed step's verdict passes, so reading the verdict before the heal
 * flag would make `healed` unreachable and render every self-heal as a plain pass — erasing exactly
 * the fact a person most needs to see. `status` wins over both because it is the producer's own
 * word, and the two below it are a reconstruction for producers that predate it.
 *
 * THE `status` WORD IS VALIDATED, NOT TRUSTED. The payload arrives as JSON from another process;
 * its declared type says what this build's producer emits, not what a build one version ahead — or
 * anything between — actually sends. An unknown word falls through to the reconstruction rather
 * than becoming an eighth status no renderer has a case for.
 */
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

/**
 * Record what a replay floor cost this viewer (D-13's visible gap marker).
 *
 * THE ARITHMETIC IS THE DOOR'S OWN, AND IT IS THE MOST LIKELY INTEGRATION ERROR THIS CONTRACT CAN
 * PRODUCE (403-03). A `410 replay_floor` advertises `earliestAvailableSeq`, so a client that saw
 * `lastSeen` re-attaches with `lastEventId = earliestAvailableSeq - 1` and the envelopes from
 * `lastSeen + 1` through `earliestAvailableSeq - 1` are gone for good.
 *
 * A gap is never cleared, because the gap happened; and a second floor never overwrites the first,
 * because the first is the one the viewer has not yet been told about.
 */
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

/**
 * Fold ONE envelope into the state. Pure: the input state is never mutated and `now` is supplied
 * by the caller.
 *
 * THE DEFAULT ARM IS DELIBERATE. Hook events, the post-processing chip group and any type a future
 * bus appends move `lastSeq` and `lastEnvelopeAt` and nothing else. The chips are Phase 404's
 * surface over durable state, not this page's; a live page that rendered them would be a second
 * place chip semantics are stated, free to disagree with the one that survives a closed socket.
 */
export function reduceRunStream(state: RunStreamState, envelope: RunEventEnvelope, now: number): RunStreamState {
  // Every envelope is activity, whatever it says — that is what makes the bus `heartbeat` count.
  // `lastSeq` takes the HIGHEST seq seen rather than the latest: a resume point that walked
  // backward on an out-of-order delivery would re-open a gap the viewer had already been served.
  const base: RunStreamState = {
    ...state,
    lastEnvelopeAt: now,
    lastSeq: Math.max(state.lastSeq, envelope.seq),
  }

  // D-12's freeze. After `runFinished` the run's log is complete; nothing that arrives later may
  // reopen a row, change a status or revise the verdict. Activity bookkeeping continues, because a
  // frozen page is not a deaf one — post-processing envelopes continue this run's seq, and a state
  // that stopped counting them would hand a reattaching client a stale resume point.
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
      // The texts crossed a trust boundary as JSON, so only an array's string entries are read, and
      // the row count stays totalSteps's however long the list is (428-30, G-428-2).
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
      // ONLY THE COORDINATES ARE READ. The payload also carries the agent's intent, its candidate
      // targets, the action result and the model's prose; none of it is destructured, so none of
      // it can reach a row. This is where D-10 is enforced, and it is enforced by what the two
      // lines below do NOT name.
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
