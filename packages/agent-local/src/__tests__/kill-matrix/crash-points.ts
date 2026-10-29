// The crash-point registry and the seam its points fire through.
//
// A crash point is DERIVED, never listed. v51's fixture carried a fixed three-member union of
// boundaries, which was right for one lifecycle and wrong for a queue whose boundaries are
// whatever each kind declares: a hand-kept list stops covering a kind the moment 388/389 rework
// one, and a coverage table computed from a stale list reports full coverage of an interruption
// that never happened. So the points come out of the declarations themselves — every declared
// checkpoint contributes the pair {immediately before its publish, immediately after it} — and a
// kind that declares no checkpoint contributes nothing, loudly.
//
// The pair is the JOBQ-03 adjacency: those two points straddle the exact instant a checkpoint
// becomes durable, so they are the two histories that must converge on resume while differing in
// whether the checkpoint had to be authored again.
//
// The SEAM is a store decorator rather than a conditional in production code. The engine reaches
// durability only through `JobStorePort`, so wrapping the port is enough to stand at either side of
// any durable write, and `packages/agent` keeps exactly zero test branches. It is deliberately
// general over the verb set rather than special-cased to `publishCheckpoint`: plan 07's adversarial
// legs stand beside `failAndChain`, `completeAndChain` and `recordCancellation`, and they are meant
// to be new selectors over THIS decorator rather than a second harness.

import type {
  JobCancelOutcome,
  JobCheckpointRecord,
  JobCheckpointReadOutcome,
  JobClaimOutcome,
  JobCompleteOutcome,
  JobEnqueueOutcome,
  JobFailureDisposition,
  JobInsert,
  JobKindDeclaration,
  JobKindRegistry,
  JobRequeueOutcome,
  JobStoreDump,
  JobStoreFence,
  JobStorePort,
} from '@vostride/agent-qa-agent'
import type { JobId, JobKind } from '@vostride/agent-qa-schema'

/** The two sides of one durable write. Ordered, because the matrix reports them in this order. */
export const JOB_CRASH_PHASES = ['before-publish', 'after-publish'] as const

export type JobCrashPhase = (typeof JOB_CRASH_PHASES)[number]

export interface JobCrashPoint {
  readonly kind: JobKind
  readonly checkpointId: string
  /** Position in the kind's declared schedule — what makes "how much was recorded" computable. */
  readonly checkpointIndex: number
  readonly phase: JobCrashPhase
  /** `kind:checkpointId:phase`. The whole of what crosses into the child as an env var. */
  readonly selector: string
}

export function crashPointSelector(
  kind: JobKind,
  checkpointId: string,
  phase: JobCrashPhase,
): string {
  return `${kind}:${checkpointId}:${phase}`
}

/**
 * Every crash point one kind contributes: two per declared checkpoint, in schedule order.
 *
 * An uncheckpointed kind contributes an empty list, which is the correct answer and not a gap —
 * `chat` resumes nothing, so there is no boundary to interrupt. The registry refuses the one
 * declaration that would make that indistinguishable from a hole (checkpointed with an empty
 * schedule), so a kind cannot reach this function claiming to checkpoint and contribute zero.
 */
export function crashPointsForKind(declaration: JobKindDeclaration): readonly JobCrashPoint[] {
  const points: JobCrashPoint[] = []
  declaration.checkpointSchedule.forEach((checkpointId, checkpointIndex) => {
    for (const phase of JOB_CRASH_PHASES) {
      points.push({
        kind: declaration.kind,
        checkpointId,
        checkpointIndex,
        phase,
        selector: crashPointSelector(declaration.kind, checkpointId, phase),
      })
    }
  })
  return points
}

export function crashPointsForDeclarations(
  declarations: readonly JobKindDeclaration[],
): readonly JobCrashPoint[] {
  return declarations.flatMap((declaration) => crashPointsForKind(declaration))
}

/** The matrix's whole iteration domain, read out of the registry rather than kept beside it. */
export function crashPointsForRegistry(registry: JobKindRegistry): readonly JobCrashPoint[] {
  return crashPointsForDeclarations(registry.list())
}

/**
 * The kinds the matrix does not interrupt, by name.
 *
 * Returned rather than skipped silently: "chat contributes no crash point" is a claim the suite
 * makes out loud, so its absence from the matrix reads as a declaration rather than as an
 * oversight, and a refactor that checkpointed a chat turn would change this list.
 */
export function uncheckpointedKinds(registry: JobKindRegistry): readonly JobKind[] {
  return registry
    .list()
    .filter((declaration) => !declaration.checkpointed)
    .map((declaration) => declaration.kind)
}

/**
 * Resolve a selector against the derived points. No default, and an unknown value is refused by
 * name before any store is opened — a child that silently ran the wrong point would report a
 * green leg for an interruption that never happened.
 */
export function parseCrashPoint(
  value: string | undefined,
  points: readonly JobCrashPoint[],
): JobCrashPoint {
  const found = points.find((point) => point.selector === value)
  if (found === undefined) {
    throw new Error(`unsupported AGENT_QA_JOB_KILL_POINT: ${String(value)}`)
  }
  return found
}

/**
 * The checkpoints that were durable when the host died — the ones JOBQ-03 forbids re-authoring.
 *
 * `before-publish` means the checkpoint being written never reached the store, so everything
 * STRICTLY before it is recorded; `after-publish` means it did, so it is included.
 */
export function recordedCheckpointsAtCrash(
  schedule: readonly string[],
  point: JobCrashPoint,
): readonly string[] {
  return schedule.slice(0, point.checkpointIndex + (point.phase === 'after-publish' ? 1 : 0))
}

/** The complement: the checkpoints a correct resume MUST author again, in schedule order. */
export function pendingCheckpointsAtCrash(
  schedule: readonly string[],
  point: JobCrashPoint,
): readonly string[] {
  return schedule.slice(recordedCheckpointsAtCrash(schedule, point).length)
}

// ---- the interception seam ---------------------------------------------------------------------

/**
 * Every verb the decorator stands beside, as a VALUE.
 *
 * A list rather than a bare union because plan 07's adversarial points are selected by verb name
 * from an environment variable, and a name that no verb answers to has to be refused rather than
 * silently never firing — a leg whose hook can never fire is a leg that proves nothing.
 */
export const JOB_STORE_VERBS = [
  'adoptEpoch',
  'enqueue',
  'claimNext',
  'completeAndChain',
  'failAndChain',
  'recordFailure',
  'releaseInterrupted',
  'requestCancel',
  'recordCancellation',
  'requeueTerminal',
  'publishCheckpoint',
  'readCheckpoint',
  'dumpState',
] as const

export type JobStoreVerb = (typeof JOB_STORE_VERBS)[number]

export interface JobStoreCall {
  readonly verb: JobStoreVerb
  readonly jobId?: string
  readonly checkpointId?: string
}

/**
 * Called immediately before and immediately after each intercepted verb reaches the real store.
 *
 * A hook that never returns is how a crash point becomes a crash: the child parks forever and the
 * parent sends the signal, so the process dies at a point it can name rather than at whatever
 * instant a timer happened to fire.
 */
export type JobStoreCrashHook = (side: 'before' | 'after', call: JobStoreCall) => void

/** The hook a derived checkpoint crash point fires through. Plan 07 supplies its own. */
export function checkpointCrashHook(
  point: JobCrashPoint,
  onReached: (call: JobStoreCall) => never,
): JobStoreCrashHook {
  const wanted = point.phase === 'before-publish' ? 'before' : 'after'
  return (side, call) => {
    if (call.verb !== 'publishCheckpoint') return
    if (call.checkpointId !== point.checkpointId) return
    if (side !== wanted) return
    onReached(call)
  }
}

// ---- crash points that are NOT a checkpoint publish (plan 07's adversarial legs) ----------------
//
// The derived points above straddle a checkpoint publish, which is the whole of JOBQ-03's happy
// path. The adversarial guarantees live beside OTHER verbs: a failure disposition commits through
// `failAndChain`, a cancellation lands through `recordCancellation`, and a kind that
// declares no checkpoint at all (chat) reaches durability only through `completeAndChain`. So the
// second point vocabulary is "a side of a named verb, optionally narrowed to one row" — the same
// decorator, a different predicate, and no second harness.

export const JOB_CRASH_SIDES = ['before', 'after'] as const

export type JobCrashSide = (typeof JOB_CRASH_SIDES)[number]

export interface JobStoreVerbCrashPoint {
  readonly verb: JobStoreVerb
  readonly side: JobCrashSide
  /**
   * The row the call must concern, when the leg needs to name one.
   *
   * Load-bearing for the failure-disposition legs: the row id distinguishes the failed head from
   * every other durable call made while its successor set is later drained.
   */
  readonly jobId?: string
  /** `verb:side` or `verb:side:jobId`. The whole of what crosses into the child as an env var. */
  readonly selector: string
}

export function verbCrashSelector(
  verb: JobStoreVerb,
  side: JobCrashSide,
  jobId?: string,
): string {
  return jobId === undefined ? `${verb}:${side}` : `${verb}:${side}:${jobId}`
}

/**
 * Resolve a verb selector. No default, and every component refused by name.
 *
 * A selector naming a verb the decorator does not intercept, or a side that does not exist, would
 * produce a hook that never fires — and a child that ran to completion instead of parking makes
 * every assertion downstream of the kill vacuous. The refusal happens before any store is opened.
 */
export function parseVerbCrashPoint(value: string | undefined): JobStoreVerbCrashPoint {
  if (value === undefined || value === '') {
    throw new Error(`unsupported AGENT_QA_JOB_KILL_VERB_POINT: ${String(value)}`)
  }
  const [verb, side, ...rest] = value.split(':')
  if (!JOB_STORE_VERBS.some((known) => known === verb)) {
    throw new Error(`unsupported AGENT_QA_JOB_KILL_VERB_POINT verb: ${String(verb)}`)
  }
  if (!JOB_CRASH_SIDES.some((known) => known === side)) {
    throw new Error(`unsupported AGENT_QA_JOB_KILL_VERB_POINT side: ${String(side)}`)
  }
  if (rest.length > 1) {
    throw new Error(`unsupported AGENT_QA_JOB_KILL_VERB_POINT: ${value}`)
  }
  const jobId = rest[0]
  return {
    verb: verb as JobStoreVerb,
    side: side as JobCrashSide,
    ...(jobId === undefined || jobId === '' ? {} : { jobId }),
    selector: value,
  }
}

/** The hook a verb crash point fires through. Same shape as `checkpointCrashHook`, other predicate. */
export function verbCrashHook(
  point: JobStoreVerbCrashPoint,
  onReached: (call: JobStoreCall) => never,
): JobStoreCrashHook {
  return (side, call) => {
    if (call.verb !== point.verb) return
    if (side !== point.side) return
    if (point.jobId !== undefined && call.jobId !== point.jobId) return
    onReached(call)
  }
}

/**
 * The real store, observed. Every verb calls through; nothing here answers on its own behalf.
 *
 * `dumpState` and `readCheckpoint` are intercepted too even though no derived point uses them, so
 * a later leg that needs to stand beside a read does not have to reopen this file.
 */
export function instrumentJobStore(store: JobStorePort, hook: JobStoreCrashHook): JobStorePort {
  function around<T>(call: JobStoreCall, body: () => Promise<T>): Promise<T> {
    hook('before', call)
    return body().then((result) => {
      hook('after', call)
      return result
    })
  }

  return {
    adoptEpoch: (epoch: number): Promise<JobStoreFence> =>
      around({ verb: 'adoptEpoch' }, () => store.adoptEpoch(epoch)),

    enqueue: (request: JobInsert): Promise<JobEnqueueOutcome> =>
      around({ verb: 'enqueue', jobId: String(request.id) }, () => store.enqueue(request)),

    claimNext: (fence: JobStoreFence): Promise<JobClaimOutcome> =>
      around({ verb: 'claimNext' }, () => store.claimNext(fence)),

    completeAndChain: (
      jobId: JobId,
      next: readonly JobInsert[],
      fence: JobStoreFence,
    ): Promise<JobCompleteOutcome> =>
      around({ verb: 'completeAndChain', jobId: String(jobId) }, () =>
        store.completeAndChain(jobId, next, fence),
      ),

    failAndChain: (
      jobId: JobId,
      disposition: Extract<JobFailureDisposition, { readonly kind: 'permanent' }>,
      next: readonly JobInsert[],
      fence: JobStoreFence,
    ): Promise<JobCompleteOutcome> =>
      around({ verb: 'failAndChain', jobId: String(jobId) }, () =>
        store.failAndChain(jobId, disposition, next, fence),
      ),

    recordFailure: (
      jobId: JobId,
      disposition: JobFailureDisposition,
      fence: JobStoreFence,
    ): Promise<void> =>
      around({ verb: 'recordFailure', jobId: String(jobId) }, () =>
        store.recordFailure(jobId, disposition, fence),
      ),

    releaseInterrupted: (jobId: JobId, fence: JobStoreFence): Promise<void> =>
      around({ verb: 'releaseInterrupted', jobId: String(jobId) }, () =>
        store.releaseInterrupted(jobId, fence),
      ),

    requestCancel: (jobId: JobId, fence: JobStoreFence): Promise<JobCancelOutcome> =>
      around({ verb: 'requestCancel', jobId: String(jobId) }, () =>
        store.requestCancel(jobId, fence),
      ),

    recordCancellation: (jobId: JobId, fence: JobStoreFence): Promise<void> =>
      around({ verb: 'recordCancellation', jobId: String(jobId) }, () =>
        store.recordCancellation(jobId, fence),
      ),

    requeueTerminal: (jobId: JobId, fence: JobStoreFence): Promise<JobRequeueOutcome> =>
      around({ verb: 'requeueTerminal', jobId: String(jobId) }, () =>
        store.requeueTerminal(jobId, fence),
      ),

    publishCheckpoint: (
      jobId: JobId,
      checkpointId: string,
      payload: JobCheckpointRecord,
      fence: JobStoreFence,
    ): Promise<void> =>
      around({ verb: 'publishCheckpoint', jobId: String(jobId), checkpointId }, () =>
        store.publishCheckpoint(jobId, checkpointId, payload, fence),
      ),

    readCheckpoint: (jobId: JobId, checkpointId: string): Promise<JobCheckpointReadOutcome> =>
      around({ verb: 'readCheckpoint', jobId: String(jobId), checkpointId }, () =>
        store.readCheckpoint(jobId, checkpointId),
      ),

    dumpState: (): Promise<JobStoreDump> => around({ verb: 'dumpState' }, () => store.dumpState()),
  }
}
