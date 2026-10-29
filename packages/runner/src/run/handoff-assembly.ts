// §A8 handoff assembly. Pure functions that fold per-member TestResults
// into PerTestOutcomes and the one CompletedRunHandoff a run persists. Three invariants live here:
//
//  1. Step re-indexing + evidence synthesis (RESEARCH Pitfall 4 / Open Q1). The loop hardcodes
//     StepEvidence.stepIndex to 0, so the authoritative index is the array position — always
//     OVERRIDDEN here. A step that carries NO §A8 evidence is NOT dropped: §A8 consumers expect
//     the step list to cover every executed step, so a minimal StepEvidence is synthesized,
//     masked-before-record like every real evidence field.
//  2. Identity is copied FROM RunConfig, never re-derived: runId/scope/buildOrdinal/
//     executionContext/configDigests on the handoff are the exact values the run keyed on, so run
//     identity and handoff identity cannot fork by construction.
//  3. REAL step evidence is masked AT REST here, through the run's own
//     MaskFn — the SAME object `projectTestFinished` routes `failureSummary` through, one frame
//     away in shell.ts. A durable artifact that records a detected value in clear is a disclosure
//     no display seam can undo: the file outlives the process that held the placeholder→value
//     pair. This is not a new rule and not a new detector; it applies the rule `failureSummary`
//     already obeys to the second field the same shell frame assembles. `maskStepNarration` is
//     the fold; the set it reaches, MASKED_HANDOFF_NARRATION_FIELDS, is spelled POSITIVELY per the
//     authoring/loop.ts rule (a negation is only readable if you already know the whole field
//     list), is derived from schema's QUOTE_SEARCHED_STEP_FIELDS, and DELIBERATELY EXCLUDES
//     `stepText`, `plannedAction` and `interpolatedVariables`: those three are exact-string-
//     matched against each other by cli/src/curation/emit-candidates.ts, and masking any one of
//     them breaks the match the other two depend on — the G-381-3 prohibition documented on
//     StepEvidence.interpolatedVariables.
//
// This module carries the EXECUTION verdict (RunStatus) and ATTACHES a caller-supplied root-cause
// Verdict onto PerTestOutcome — it never DERIVES one (§A9 boundary): all root-cause logic
// lives in run/root-cause.ts behind the shell's classify call. No fs, no providers.

import type {
  CompletedRunHandoff,
  DeclaredModelProfile,
  MemberTestOutcome,
  ModelIdentity,
  PerTestOutcome,
  RecordedActionResult,
  RunStatus,
  ScopeKey,
  StepEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import { canonicalJson, CURRENT_HANDOFF_SCHEMA_VERSION, maskPayloadStrings, screenStateHash, sha256hex } from '@vostride/agent-qa-schema'
import type { MaskFn } from '@vostride/agent-qa-schema'
import type { RunConfig, RunMemberDescriptor } from './ports.js'
import type { StepResult, TestResult } from '../result.js'
import { makeEmptyServedBrief } from '../loop/evidence.js'

interface SynthDeps {
  scope: ScopeKey
  buildOrdinal: number
  mask: MaskFn
  modelProfile?: DeclaredModelProfile
  verifierIdentity?: ModelIdentity
  toolSchemaDigest?: string
}

/**
 * Synthesize a minimal, fully-typed {@link StepEvidence} for an executed step the loop finished
 * WITHOUT recording §A8 evidence (Open Q1: synthesize, do not drop). `cacheStatus` is `'bypass'`
 * — the shipped not-cache-served member of the union (the step never touched the cache) — and the
 * verifier verdict mirrors the step status with its error text passed through `mask` (masked-
 * before-record, identical to real evidence). `servedBrief` is the canonical empty brief.
 */
export function synthesizeStepEvidence(step: StepResult, stepIndex: number, deps: SynthDeps): StepEvidence {
  const passed = step.status === 'passed' || step.status === 'healed'
  const reasoning = step.error ?? `synthesized: step "${step.name}" ${step.status} (no §A8 evidence recorded)`
  return {
    stepIndex,
    stepText: deps.mask(step.name),
    cacheStatus: 'bypass',
    servedBrief: makeEmptyServedBrief(deps.scope, deps.buildOrdinal),
    subActions: [],
    verifierVerdict: {
      pass: passed,
      reasoning: deps.mask(reasoning),
    },
    ...(deps.modelProfile !== undefined ? { modelProfile: deps.modelProfile } : {}),
    ...(deps.verifierIdentity !== undefined ? { verifierIdentity: deps.verifierIdentity } : {}),
    ...(deps.toolSchemaDigest !== undefined ? { toolSchemaDigest: deps.toolSchemaDigest } : {}),
  }
}

/**
 * THE FIELDS OF A REAL {@link StepEvidence} THIS MODULE MASKS AT REST.
 *
 * A POSITIVE SET, asserted on this value itself in `__tests__/handoff-assembly.test.ts` rather
 * than inferred from a case that happened to pass — so an edit that GROWS or SHRINKS it reds a
 * cell by NAME even when no behavioural case notices. Growth is the dangerous direction: every
 * addition here is a candidate G-381-3 break.
 *
 * THE SET IS "THE FIELDS THIS MODULE IS THE LAST MASKER FOR", not an arithmetic on schema's
 * `QUOTE_SEARCHED_STEP_FIELDS`. An earlier note here said "that set MINUS `stepText`", which is
 * wrong in both directions and is exactly what a later editor would re-derive from. Each member:
 *
 *   - `verifierVerdict.reasoning`     — the verifier's own words about what it saw
 *   - `subActions[].plan`             — a planning turn's stated intent
 *   - `subActions[].result.error`     — a captured failure message, verbatim from the app
 *   - `subActions[].result.data`      — a captured payload of unknown shape
 *   - `subActions[].result.metadata`  — a captured payload of unknown shape
 *
 * The last two are NOT quote-searched at all. They are here because they are captured payloads of
 * unknown shape, which is a disclosure question and not a grounding-quote question.
 *
 * And five searched fields are deliberately absent. `stepText` is the carve-out below. The other
 * four arrive here ALREADY masked, at record time, so masking them again would be a second masker
 * for one field:
 *
 *   - `canonicalJson(reportedValue)`  — `schema/handoff/step-evidence.ts`, "masked-before-record"
 *   - `canonicalJson(assertOutcome)`  — same file, same words, on the assertValue block
 *   - `canonicalJson(aiJudgment)`     — `schema/handoff/verb-evidence.ts`, rationale masked-
 *                                       before-record
 *   - `canonicalJson(termination)`    — `runner/src/loop/index.ts`, whose `reason` goes through
 *                                       `redactSecretValue` before `recordTermination`
 *
 * NOT on this list, and that omission is load-bearing rather than an oversight: `stepText`,
 * `subActions[].plannedAction` and `interpolatedVariables` are exact-string-matched against one
 * another by `cli/src/curation/emit-candidates.ts` (`testVariableSourceName`). Masking any one of
 * them makes an email-valued login binding stop matching, emits no source name, and leaves replay
 * permanently `hint` — G-381-3 itself, spelled out on `StepEvidence.interpolatedVariables`.
 */
export const MASKED_HANDOFF_NARRATION_FIELDS = [
  'verifierVerdict.reasoning',
  'subActions[].plan',
  'subActions[].result.error',
  'subActions[].result.data',
  'subActions[].result.metadata',
] as const

/**
 * One narration field's override, present only when there is a string to mask.
 *
 * The whole module spells optionals this way, and this is the spelling of the fold's totality
 * claim: a member that is not there stays not there, rather than becoming an undefined-valued key
 * that survives the JSON round trip as a field every later consumer has to defend against. A
 * member that is not there also carries nothing to disclose, so totality costs no masking.
 */
function maskWhenString<K extends string>(
  key: K,
  value: string | undefined,
  mask: MaskFn,
): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: mask(value) } as Record<K, string>)
}

/**
 * Mask the narration members of one {@link RecordedActionResult}, under this module's
 * spread-when-defined idiom so an absent key stays absent and no undefined hole survives the JSON
 * round-trip.
 *
 * `success` and `annotation` are deliberately NOT members of the overrides: the first is a boolean
 * and the second a geometry union whose `kind` is control flow for every consumer that reads it.
 * Leaving them out of the transform is what makes their survival a guarantee rather than a
 * coincidence of the mask happening to be a no-op on non-strings.
 */
function maskRecordedResult(result: RecordedActionResult, mask: MaskFn): RecordedActionResult {
  return {
    ...result,
    ...(result.error !== undefined ? { error: mask(result.error) } : {}),
    ...(result.data !== undefined ? { data: maskPayloadStrings(result.data, mask) } : {}),
    ...(result.metadata !== undefined
      ? { metadata: maskPayloadStrings(result.metadata, mask) }
      : {}),
  }
}

/**
 * Mask exactly {@link MASKED_HANDOFF_NARRATION_FIELDS} of one real {@link StepEvidence}, through
 * the run's own `mask`. Every other member rides the spread untouched.
 *
 * It does NOT reach `stepText`, `subActions[].plannedAction` or `interpolatedVariables` (the
 * G-381-3 carve-out above), nor `subActions[].stateBefore` / `stateAfter` — the captured screen
 * state is the APP's own page, and `stateBefore.elements` is what `exercisedAnchors` and
 * `emit-candidates.ts` resolve refs and element ordinals against. Nor `artifactRefs` /
 * `decisionScreenshotRef`, whose `sha` is a content-addressed lookup key.
 *
 * Both overrides are spread-WHEN-PRESENT, like every other optional in this module. `StepEvidence`
 * declares both members required, so a well-typed producer always supplies them — but this
 * function transforms a value it did not construct, and a partial one must come out of the fold
 * exactly as it went in rather than gaining an undefined-valued key (or throwing). A member that
 * is not there carries nothing to disclose, so totality costs no masking.
 */
function maskStepNarration(evidence: StepEvidence, mask: MaskFn): StepEvidence {
  const verdict = evidence.verifierVerdict as StepEvidence['verifierVerdict'] | undefined
  const subActions = evidence.subActions as StepEvidence['subActions'] | undefined
  return {
    ...evidence,
    ...(verdict !== undefined
      ? { verifierVerdict: { ...verdict, ...maskWhenString('reasoning', verdict.reasoning, mask) } }
      : {}),
    ...(subActions !== undefined
      ? {
          subActions: subActions.map(subAction => {
            // WIDENED, LIKE THE TWO ABOVE. The schema declares both members required, so these
            // casts are the only way to ask the question the doc block promises an answer to.
            const plan = subAction.plan as string | undefined
            const result = subAction.result as RecordedActionResult | undefined
            return {
              ...subAction,
              ...maskWhenString('plan', plan, mask),
              ...(result !== undefined ? { result: maskRecordedResult(result, mask) } : {}),
            }
          }),
        }
      : {}),
  }
}

/**
 * Fold one completed member {@link TestResult} + its derived {@link MemberTestOutcome} into a
 * {@link PerTestOutcome}. Steps are built from `result.steps`: a step with §A8 evidence carries it
 * (with `stepIndex` OVERRIDDEN to its array position); an evidence-less step gets a synthesized
 * minimal StepEvidence. `testIndex` is the shell-owned array position.
 *
 * `rootCause` is the shell-classified §A9 verdict: attached ONLY when defined so clean
 * passes/skipped/cancelled members stay rootCause-free in the persisted JSON (the D-01 presence
 * rule — the key is absent, never undefined-valued).
 *
 * `deps.quarantined` is the 390 D-14 disposition, stamped BESIDE `outcome` under the same
 * presence rule. It never alters `outcome`: a quarantined failing member reads `'failed'` here, and
 * the licence to ignore that failure lives entirely in the aggregate rule and in this marker.
 */
export function assemblePerTestOutcome(
  member: RunMemberDescriptor,
  result: TestResult,
  outcome: MemberTestOutcome,
  deps: {
    testIndex: number
    scope: ScopeKey
    buildOrdinal: number
    mask: MaskFn
    modelProfile?: DeclaredModelProfile
    verifierIdentity?: ModelIdentity
    toolSchemaDigest?: string
    quarantined?: true
  },
  rootCause?: Verdict,
  origin?: { runId: string; outcome: 'failed' | 'timeout'; rootCause?: Verdict },
): PerTestOutcome {
  const synthDeps: SynthDeps = {
    scope: deps.scope,
    buildOrdinal: deps.buildOrdinal,
    mask: deps.mask,
    modelProfile: deps.modelProfile,
    verifierIdentity: deps.verifierIdentity,
    toolSchemaDigest: deps.toolSchemaDigest,
  }
  const steps: StepEvidence[] = result.steps.map((step, index) =>
    step.evidence !== undefined
      ? maskStepNarration({ ...step.evidence, stepIndex: index }, deps.mask)
      : synthesizeStepEvidence(step, index, synthDeps),
  )
  let rerunOrigin: PerTestOutcome['rerunOrigin']
  const firstFailure = result.firstFailedAttempt
  if (origin !== undefined && firstFailure !== undefined &&
      Number.isSafeInteger(firstFailure.attempt) && firstFailure.attempt >= 0 &&
      Number.isSafeInteger(result.retryCount) && firstFailure.attempt < result.retryCount!) {
    const decisions: NonNullable<PerTestOutcome['rerunOrigin']>['decisions'] = []
    firstFailure.result.steps.forEach((step, stepIndex) => {
      // No recorded §A8 decision means no identity. Never mine legacy trace/failure prose.
      if (step.evidence === undefined) return
      // Reuse the final narration projection, then mask the whole origin-only copy. The
      // original has no interpolation consumer: its receipt join uses these masked facts.
      // Final step/action/interpolation bytes retain their existing G-381-3 contract.
      const evidence = maskPayloadStrings(
        maskStepNarration({ ...step.evidence, stepIndex }, deps.mask), deps.mask,
      )
      evidence.subActions.forEach((subAction, decisionOrdinal) => {
        const facts = {
          runId: origin.runId, testId: member.testId, testIndex: deps.testIndex,
          stepIndex, decisionOrdinal, evidence,
        }
        decisions.push({
          ...facts,
          screenStateHash: screenStateHash(subAction.stateBefore),
          evidenceDigest: sha256hex(canonicalJson(facts)),
        })
      })
    })
    const facts = {
      attempt: firstFailure.attempt,
      outcome: origin.outcome,
      ...(origin.rootCause !== undefined
        ? { rootCause: maskPayloadStrings(origin.rootCause, deps.mask) }
        : {}),
      decisions,
    }
    rerunOrigin = { ...facts, evidenceDigest: sha256hex(canonicalJson(facts)) }
  }
  return {
    testId: member.testId,
    testName: member.name,
    filePath: member.filePath,
    testIndex: deps.testIndex,
    outcome,
    steps,
    ...(rerunOrigin !== undefined ? { rerunOrigin } : {}),
    ...(rootCause !== undefined ? { rootCause } : {}),
    ...(deps.quarantined === true ? { quarantined: true as const } : {}),
    // approved member grain, for passing AND failing retries.
    ...(result.retryCount !== undefined && result.retryCount > 0
      ? { isRerun: true as const, rerunAttempt: result.retryCount }
      : {}),
  }
}

/**
 * The shell-produced skip outcome: a member the shell never invoked (run aborted, or a
 * poisoned same-group member). `outcome: 'skipped'`, no steps — neutral in the aggregate fold.
 *
 * `quarantined` is still stamped when the ledger licensed this member: the disposition
 * describes the TEST's standing, not the outcome it happened to reach, so a reader of the handoff
 * sees the same truth whether the member ran or was skipped past.
 */
export function skippedPerTestOutcome(
  member: RunMemberDescriptor,
  testIndex: number,
  quarantined?: true,
): PerTestOutcome {
  return {
    testId: member.testId,
    testName: member.name,
    filePath: member.filePath,
    testIndex,
    outcome: 'skipped',
    steps: [],
    ...(quarantined === true ? { quarantined: true as const } : {}),
  }
}

/**
 * Assemble the one {@link CompletedRunHandoff} a run persists. Every header field is copied
 * verbatim FROM the resolved {@link RunConfig} (D-04/D-20 — never re-derived); `aggregateVerdict`
 * is the execution verdict; `tests` are the assembled per-member outcomes in run order.
 *
 * `quarantineApplied` records the ledger entries this run was operating under, copied
 * from the same resolved config the disposition markers were matched against — so the run's own
 * receipt answers "which suppressions were licensed here, and until when" without re-reading a
 * ledger that may since have changed. An empty set stays ABSENT, keeping every unquarantined run's
 * handoff bytes identical to pre-390.
 */
export function assembleHandoff(
  config: RunConfig,
  outcomes: PerTestOutcome[],
  aggregateVerdict: RunStatus,
  timing: { startedAt: number; endedAt: number },
): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: config.runId,
    scope: config.scope,
    buildOrdinal: config.buildOrdinal,
    ...(config.excludedFromOutcomes === true ? { excludedFromOutcomes: true } : {}),
    ...(config.gateRun === true ? { gateRun: true } : {}),
    executionContext: config.executionContext,
    aggregateVerdict,
    configDigests: config.configDigests,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    tests: outcomes,
    ...(config.quarantined !== undefined && config.quarantined.length > 0
      ? { quarantineApplied: config.quarantined }
      : {}),
    ...(config.plannerLimits === undefined ? {} : { plannerLimits: config.plannerLimits }),
  }
}
