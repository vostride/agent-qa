// Gates 1 and 2 — the stability driver.
//
// Gate 1 asks whether the draft reached a DEFINITIVE verdict; gate 2 asks whether that verdict
// HELD. Both are answered from execution evidence alone — never from `analyze-run`'s authoring
// output (the verdict/post-processing split, live-view.md §4) — and both read the DRAFT'S OWN
// member-test outcome rather than the run's aggregate, because the aggregate carries
// quarantine-aware rules that are noise for a draft nobody has ever run before.
//
// EVERY START INPUT CARRIES BOTH MARKERS. `gateRun: true` and
// `excludedFromOutcomes: true` are distinct axes and both are set on every run this module takes.
// A gate-run that entered the outcome fold would seed the very union gate 3 later compares the
// draft against, and the corruption accumulates in a derived index rather than announcing itself.
// The markers are not merely SENT — the acknowledgment is checked, because `runs.start` copies
// them off the durable record instead of echoing the request, so an acknowledgment without them
// is the host reporting that the run was not accepted as a gate-run.

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
        'the draft is later compared against (WTST-06).',
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
  /** True when D-17's early-stop fired: the reason a completed count may be below N. */
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

/**
 * Member outcomes that represent a FINAL answer about the draft.
 *
 * `healed` is here and it is load-bearing rather than lenient: 393-01 measured the accept
 * control's definitive pass arriving as `healed`, not `passed` (F3), on the very draft the corpus
 * exists to accept. A gate 1 that treats a heal as indefinitive fails it.
 */
const DEFINITIVE_MEMBER_OUTCOMES: ReadonlySet<string> = new Set<MemberTestOutcome>([
  'passed',
  'failed',
  'healed',
])

/** The sentinel `memberOutcome` for a run whose document held no member for this draft. */
export const ABSENT_MEMBER_OUTCOME = 'absent'

/**
 * The verdict gate 2 COMPARES across runs — `healed` folded into `passed`.
 *
 * A heal is a recovery within one run, not a different answer about the app, and 393-01's F2
 * measured heals arriving on 5 of 8 corpus drafts from seeded procedure replay. Comparing the raw
 * enum would make nearly every draft read unstable for a reason that is about the knowledge store
 * rather than about the draft — a false gate-2 rejection, which is the direction that costs a user
 * a good test. The raw enum survives per run on the receipt, so nothing is hidden by the fold.
 */
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

/**
 * Whether this run reached a FINAL answer about the draft, and what was read to decide.
 *
 * THE ENUM IS NOT ENOUGH, AND NEITHER IS ANY SINGLE TERMINAL FIELD. 393-01 measured both halves.
 * F1: a draft naming controls the target does not have comes back `failed` — a definitive value —
 * while its step evidence carries an infeasible termination, and 19 of 21 failed members in the
 * demo run store carry one, so gate 1 read off the enum alone passes the corpus's own gate-1
 * rejector. F3: the accept control's definitive pass arrives as `healed`, so a gate 1 strict about
 * the enum fails the draft the corpus exists to accept. The answer is therefore a COMPOSITE —
 * the enum admits the run, the step evidence can still disqualify it — which is exactly the shape
 * `GateRunRecordSchema` was minted for: `definitive` is a judgment, not a field copy, and `reason`
 * is where the judgment says what it read.
 *
 * WHERE D-17'S "error" WENT. The decision text lists planning failure, infeasible termination,
 * cycle, error, timeout and cancelled. There is no `'error'` member outcome on this build —
 * `RunStatus` is `passed | failed | healed | timeout | cancelled` — and the class it names arrives
 * in one of two shapes that ARE handled: a structural `planningFailure` block (393-01 measured one
 * on page-loaded-only's first run, a guardrail block during planning) or a run whose record cannot
 * be read back at all. Neither is folded into a synthetic enum member, because inventing an
 * outcome value the vocabulary does not have would put a second spelling of `RunStatus` in this
 * file.
 *
 * ORDER IS FOR THE READER, NOT THE VERDICT. Any one cause is disqualifying, so the result does not
 * depend on which is checked first; the order decides which cause the receipt NAMES when a run has
 * more than one, and the enum is checked first because it is the coarsest.
 */
function classifyGateRun(member: PerTestOutcome): { definitive: boolean; reason: string } {
  if (!DEFINITIVE_MEMBER_OUTCOMES.has(member.outcome)) {
    return {
      definitive: false,
      reason: `member outcome '${member.outcome}' is not a final pass or fail (D-17)`,
    }
  }

  for (const step of member.steps) {
    if (step.planningFailure !== undefined) {
      return {
        definitive: false,
        reason: `planning failed structurally on step ${step.stepIndex}: the draft was never `
          + 'executed to a verdict, so the enum below describes the attempt, not the app (D-17)',
      }
    }
    if (step.limitStop !== undefined) {
      const { limit, used, configured } = step.limitStop
      return {
        definitive: false,
        reason: `step ${step.stepIndex} stopped at its ${limit} limit (${used} of ${configured} `
          + 'used): the run ran out of limit, not into an answer (D-12)',
      }
    }
    // Historical reader: only pre-436 handoffs carry a cycle block.
    if (step.cycle !== undefined) {
      return {
        definitive: false,
        reason: `a cycle was flagged on step ${step.stepIndex} (${step.cycle.reason}): the run `
          + 'stopped revisiting state rather than reaching an answer (D-17)',
      }
    }
    if (step.termination !== undefined) {
      return {
        definitive: false,
        reason: `step ${step.stepIndex} terminated '${step.termination.kind}' `
          + `(${step.termination.reason}) — indefinitive despite member outcome `
          + `'${member.outcome}', which reads definitive on its own (393-01 F1)`,
      }
    }
  }

  return {
    definitive: true,
    reason: `member outcome '${member.outcome}' with no planning failure, limit stop, cycle flag `
      + 'or termination on any step — a final answer about the draft'
      + (member.outcome === 'healed' ? '; a healed pass IS a pass (393-01 F3)' : ''),
  }
}

/**
 * The `runs.start` input for one gate-run.
 *
 * `patterns` names the draft file and nothing else, so the run admits exactly the member the
 * gates then look for. The draft path is passed through as handed in — boundary validation (is
 * this path inside the workspace at all?) belongs at the op invoke where the resolved config
 * exists, and is plan 07's T-393-01 discharge.
 */
function gateRunStartInput(draft: ParsedDraftLike): RunsStartInput {
  return {
    patterns: [draft.filePath],
    gateRun: true,
    excludedFromOutcomes: true,
  }
}

/**
 * Take up to `runsRequested` gate-runs and answer gates 1 and 2.
 *
 * EARLY-STOP SKIPS RUNS, NEVER A GATE. Once two different verdicts have been observed
 * the flip is proven and the remaining runs cannot un-prove it, so they are not taken. Both
 * booleans are still computed and both are still reported — what shrinks is `runsCompleted`, which
 * is why `computeDraftDisposition` reads a short count as `rejected` rather than as `proposal-only`
 * when a gate is false.
 *
 * ONLY OBSERVED VERDICTS PARTICIPATE. A run whose record could not be read, or whose document
 * holds no member for this draft, fails gate 1 and contributes nothing to gate 2. Missing
 * information is not a different answer: counting it as a flip would fail gate 2 for an
 * infrastructure hiccup — the direction that costs a user a good test — and would early-stop the
 * evaluation, throwing away the runs that could still have said something.
 */
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
    // An evaluation that observed no verdict at all has not shown stability; it has shown nothing.
    // D-12's tune-toward-reject applies — a gate with no evidence behind it is not a pass.
    stableVerdict: distinctOutcomes.length === 1,
    gateRuns,
    runsCompleted: gateRuns.length,
    earlyStopped,
    distinctOutcomes,
    draftMembers,
  }
}
