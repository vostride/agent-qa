// Masks narration at rest, never `stepText`, `plannedAction` or `interpolatedVariables`.

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

// No recorded evidence: `cacheStatus` is `bypass` and the error passes through `mask`.
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

// Masked at rest here; the identity fields stay out because replay matches them exactly.
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

// Masks only those fields; screen state and content-addressed refs ride untouched.
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

// `rootCause` and `quarantined` are stamped only when defined; `outcome` is never altered.
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
      // Mask the whole origin-only copy; the final step, action and interpolation bytes stay exact.
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
    // Retry counts ride the member, for passing and failing retries.
    ...(result.retryCount !== undefined && result.retryCount > 0
      ? { isRerun: true as const, rerunAttempt: result.retryCount }
      : {}),
  }
}

// `quarantined` describes the test's standing, so it is stamped on a skipped member too.
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

// Header fields are copied from the resolved RunConfig; an empty `quarantineApplied` stays absent.
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
