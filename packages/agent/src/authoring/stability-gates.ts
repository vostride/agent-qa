// Every gate-run carries both markers, checked on the acknowledgment, or it seeds gate 3's union.

import { DRAFT_STABILITY_RUNS_N } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  GateRunRecord,
  MemberTestOutcome,
  PerTestOutcome,
  RunsStartInput,
} from '@vostride/agent-qa-schema'

import type { DraftRunPortLike, ParsedDraftLike } from './ports.js'

/**
 * The run was started but the host did not report it back as a gate-run.
 *
 * A refusal rather than a warning, and the reasoning is about blast radius. Every other failure
 * in this module degrades one draft's receipt; this one silently widens the suite union with the
 * draft's own evidence, in a derived index that accumulates across runs, so the next draft
 * evaluated against it reads its own surface as already covered. Nothing downstream can detect
 * that from a receipt. Stopping is the only response that keeps the corruption from compounding.
 */
export class GateRunNotFlaggedError extends Error {
  constructor(readonly runId: string, readonly acknowledged: {
    gateRun?: true
    excludedFromOutcomes?: true
  }) {
    super(
      `runs.start accepted ${runId} without both gate-run markers ` +
        `(gateRun=${String(acknowledged.gateRun)}, ` +
        `excludedFromOutcomes=${String(acknowledged.excludedFromOutcomes)}): ` +
        'an unflagged gate-run pollutes the outcome projection and the suite fingerprint union ' +
        'the draft is later compared against.',
    )
    this.name = 'GateRunNotFlaggedError'
  }
}

export interface RunStabilityGatesInput {
  readonly draft: ParsedDraftLike
  readonly runPort: DraftRunPortLike
  /** How many runs to take. `1` is draft mode; absent means the pinned N. */
  readonly runsRequested?: number
}

export interface StabilityGatesResult {
  /** Gate 1. */
  readonly executesDefinitive: boolean
  /** Gate 2. */
  readonly stableVerdict: boolean
  /** One row per run taken, in order — the receipt's `gateRuns`. */
  readonly gateRuns: GateRunRecord[]
  readonly runsCompleted: number
  // True when early stop fired: why a completed count may be below N.
  readonly earlyStopped: boolean
  /**
   * The distinct COMPARISON verdicts observed; `length > 1` is the flip, exactly as
   * `DraftGateResultsSchema.stableVerdict.distinctOutcomes` promises. Raw member-outcome enum
   * values live per run on `gateRuns[].memberOutcome`.
   */
  readonly distinctOutcomes: string[]
  /**
   * The draft's own member outcome from each run that produced one, in order.
   *
   * Gate 3's draft-side elements are computed from these — see `verify-draft.ts`. Carried out of
   * this module rather than re-read because the run documents are already in hand here, and
   * fetching them twice would let the two gates disagree about which run they are describing.
   */
  readonly draftMembers: PerTestOutcome[]
}

// `healed` is definitive: the accept control's pass arrives as a heal.
const DEFINITIVE_MEMBER_OUTCOMES: ReadonlySet<string> = new Set<MemberTestOutcome>([
  'passed',
  'failed',
  'healed',
])

/** The sentinel `memberOutcome` for a run whose document held no member for this draft. */
export const ABSENT_MEMBER_OUTCOME = 'absent'

// A heal is recovery within one run, not a different answer, so it compares as `passed`.
function comparisonVerdict(memberOutcome: string): string {
  return memberOutcome === 'healed' ? 'passed' : memberOutcome
}

/** The draft's own member in a run document, by stable identity (never `testId`). */
export function findDraftMember(
  document: CompletedRunHandoff,
  draft: ParsedDraftLike,
): PerTestOutcome | undefined {
  return document.tests.find(
    (member) => member.filePath === draft.filePath && member.testName === draft.testName,
  )
}

/** Whether any step recorded a self-heal, beside the member outcome's own `healed` arm. */
function recordedHeal(member: PerTestOutcome): boolean {
  return member.outcome === 'healed'
    || member.steps.some((step) => step.selfHeal !== undefined)
}

// The enum admits a run and step evidence can still disqualify it; order picks the named cause.
function classifyGateRun(member: PerTestOutcome): { definitive: boolean; reason: string } {
  if (!DEFINITIVE_MEMBER_OUTCOMES.has(member.outcome)) {
    return {
      definitive: false,
      reason: `member outcome '${member.outcome}' is not a final pass or fail`,
    }
  }

  for (const step of member.steps) {
    if (step.planningFailure !== undefined) {
      return {
        definitive: false,
        reason: `planning failed structurally on step ${step.stepIndex}: the draft was never `
          + 'executed to a verdict, so the enum below describes the attempt, not the app',
      }
    }
    if (step.limitStop !== undefined) {
      const { limit, used, configured } = step.limitStop
      return {
        definitive: false,
        reason: `step ${step.stepIndex} stopped at its ${limit} limit (${used} of ${configured} `
          + 'used): the run ran out of limit, not into an answer',
      }
    }
    // Reads the cycle block that older handoffs still carry.
    if (step.cycle !== undefined) {
      return {
        definitive: false,
        reason: `a cycle was flagged on step ${step.stepIndex} (${step.cycle.reason}): the run `
          + 'stopped revisiting state rather than reaching an answer',
      }
    }
    if (step.termination !== undefined) {
      return {
        definitive: false,
        reason: `step ${step.stepIndex} terminated '${step.termination.kind}' `
          + `(${step.termination.reason}) — indefinitive despite member outcome `
          + `'${member.outcome}', which reads definitive on its own`,
      }
    }
  }

  return {
    definitive: true,
    reason: `member outcome '${member.outcome}' with no planning failure, limit stop, cycle flag `
      + 'or termination on any step — a final answer about the draft'
      + (member.outcome === 'healed' ? '; a healed pass is a pass' : ''),
  }
}

// `patterns` names only the draft file; path validation belongs at the op boundary.
function gateRunStartInput(draft: ParsedDraftLike): RunsStartInput {
  return {
    patterns: [draft.filePath],
    gateRun: true,
    excludedFromOutcomes: true,
  }
}

// Early stop skips runs, never a gate; an unread run fails gate 1 and is no flip for gate 2.
export async function runStabilityGates(
  input: RunStabilityGatesInput,
): Promise<StabilityGatesResult> {
  const runsRequested = input.runsRequested ?? DRAFT_STABILITY_RUNS_N
  const gateRuns: GateRunRecord[] = []
  const draftMembers: PerTestOutcome[] = []
  const observedVerdicts: string[] = []
  let earlyStopped = false

  for (let taken = 0; taken < runsRequested; taken += 1) {
    const acknowledgement = await input.runPort.start(gateRunStartInput(input.draft))
    if (acknowledgement.gateRun !== true || acknowledgement.excludedFromOutcomes !== true) {
      throw new GateRunNotFlaggedError(acknowledgement.runId, acknowledgement)
    }

    const document = await input.runPort.get(acknowledgement.runId)
    const member = document === undefined ? undefined : findDraftMember(document, input.draft)

    if (member === undefined) {
      gateRuns.push({
        runId: acknowledgement.runId,
        memberOutcome: ABSENT_MEMBER_OUTCOME,
        definitive: false,
        healed: false,
        reason: document === undefined
          ? 'no completed-run record was readable for this run: nothing is known about it, '
            + 'which is a gate-1 failure and not a verdict'
          : 'the run document holds no member for '
            + `(${input.draft.filePath}, ${input.draft.testName}) — the stable identity, `
            + 'never testId',
      })
      continue
    }

    draftMembers.push(member)
    const { definitive, reason } = classifyGateRun(member)
    gateRuns.push({
      runId: acknowledgement.runId,
      memberOutcome: member.outcome,
      definitive,
      healed: recordedHeal(member),
      reason,
    })

    observedVerdicts.push(comparisonVerdict(member.outcome))
    if (new Set(observedVerdicts).size > 1) {
      earlyStopped = taken + 1 < runsRequested
      break
    }
  }

  const distinctOutcomes = [...new Set(observedVerdicts)]

  return {
    executesDefinitive: gateRuns.length > 0 && gateRuns.every((row) => row.definitive),
    // No observed verdict shows nothing, so the gate does not pass.
    stableVerdict: distinctOutcomes.length === 1,
    gateRuns,
    runsCompleted: gateRuns.length,
    earlyStopped,
    distinctOutcomes,
    draftMembers,
  }
}
