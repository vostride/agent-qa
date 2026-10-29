import { RecordedRetrievalRungSchema } from '../brief/retrieval-rung'
import { ServedRetrievalTraceV1Schema } from '../brief/retrieval-trace'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from './completed-run-handoff'
import type { CompletedRunHandoff } from './completed-run-handoff'
import {
  createVersionGuard,
  VersionGuardError,
} from '../versioning/create-version-guard'
import type { MigrationRegistry } from '../versioning/create-version-guard'
import { isVerdictClass } from '../verdict/verdict'
import { hasMemoryOnPathShape } from '../verdict/memory-on-path'
import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import { screenStateHash } from '../determinism/screen-hash'
import type { StepEvidence } from './step-evidence'
import {
  CITATION_SOURCES,
  CONDITION_ENDINGS,
  CONDITION_GUARDS,
  CONDITION_NEEDS,
  CONDITION_VERDICTS,
} from './condition-evidence'

/** Thrown when a stored handoff's `schemaVersion` is not {@link CURRENT_HANDOFF_SCHEMA_VERSION}. */
export class HandoffVersionError extends VersionGuardError {
  constructor(found: number, supported: number) {
    super('CompletedRunHandoff', found, supported)
    this.name = 'HandoffVersionError'
  }
}

export const HANDOFF_MIGRATIONS: MigrationRegistry = {}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validates an ElementInfo member of `stateBefore.elements` at the VALUE level the
 * load-boundary consumers operate on: locatorForElement applies `.trim()` to attribute
 * values and `.replaceAll()` to attribute/label values, and elementAnchor mints `el`
 * anchors from `role`/`nameNormalized` that normalizeAnchor string-normalizes
 * (normalizeHumanText). Rejects no honest document: `role` and `nameNormalized` are
 * required strings on ElementInfo, `attributes` is Record<string,string>, and every
 * ElementLabels member is an optional string.
 */
function hasCompleteElementShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  if (typeof value.role !== 'string') return false
  if (typeof value.nameNormalized !== 'string') return false
  const attributes = value.attributes
  const labels = value.labels
  return (
    isNonArrayObject(attributes) &&
    Object.values(attributes).every((member) => typeof member === 'string') &&
    isNonArrayObject(labels) &&
    Object.values(labels).every((member) => typeof member === 'string')
  )
}

function hasCompleteStateBeforeShape(stateBefore: unknown): boolean {
  if (!isNonArrayObject(stateBefore)) return false
  if ('url' in stateBefore && typeof stateBefore.url !== 'string') return false
  return Array.isArray(stateBefore.elements) && stateBefore.elements.every(hasCompleteElementShape)
}

/**
 * Validates a `subActions` element against the consumer-dereferenced surface: actionRefs
 * applies the `in` operator to `plannedAction`, resolvedElementEvidence walks
 * `stateBefore.elements`, and resolvedActionRefs flatMaps `grounding.attempts` for
 * EVERY subAction — so a present `grounding` must be a non-array object and present
 * `attempts` an array of non-array objects (absence stays legal: the consumer's `?? []`
 * handles it; attempt interiors stay unvalidated because the consumer's `outcome`
 * strict-equality and `resolvedRef` undefined-check reads are crash-safe on any
 * non-null object). classifySubActionRoute reads BOTH `stateBefore.url` and
 * `stateAfter?.url`, and when both are defined and differ it mints the AFTER leg as
 * the navigated `page` Anchor route normalizeAnchor trims — so both urls must be
 * strings when present. `stateAfter` absence stays legal (the consumer's optional
 * chain handles it); when present it must be a non-array object, and its interiors
 * beyond `url` stay unvalidated because no load-boundary consumer dereferences them.
 * `stateBefore.platform` stays unvalidated — its only read is an absence-safe
 * identity join.
 */
function hasCompleteSubActionShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  if (!isNonArrayObject(value.plannedAction)) return false
  if ('grounding' in value) {
    const grounding = value.grounding
    if (!isNonArrayObject(grounding)) return false
    if (
      'attempts' in grounding &&
      (!Array.isArray(grounding.attempts) ||
        !grounding.attempts.every(isNonArrayObject))
    ) {
      return false
    }
  }
  if (!hasCompleteStateBeforeShape(value.stateBefore)) return false
  // Curation dereferences the healed dispatch pair as it does the planner's.
  if ('healedDispatch' in value) {
    const healed = value.healedDispatch
    if (!isNonArrayObject(healed) || !isNonArrayObject(healed.action)) return false
    if (!hasCompleteStateBeforeShape(healed.stateBefore)) return false
  }
  if ('stateAfter' in value) {
    const stateAfter = value.stateAfter
    if (!isNonArrayObject(stateAfter)) return false
    if ('url' in stateAfter && typeof stateAfter.url !== 'string') return false
  }
  return true
}

// Mirrors the Anchor union so every admitted `citedAnchors` member survives `normalizeAnchor`.
function isAnchorShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  switch (value.t) {
    case 'page':
      return typeof value.route === 'string'
    case 'flow':
      return typeof value.name === 'string'
    case 'el':
      return (
        typeof value.role === 'string' &&
        typeof value.name === 'string' &&
        (!('ordinal' in value) || typeof value.ordinal === 'number')
      )
    case 'platform':
      return (
        value.platform === 'web' ||
        value.platform === 'android' ||
        value.platform === 'ios'
      )
    case 'selector':
      return typeof value.literal === 'string'
    case 'error':
      return typeof value.message === 'string'
    default:
      return false
  }
}

// Requires string `id` and `sha` so descriptor mapping is total; the consumer checks hex format.
function isArtifactRefShape(value: unknown): boolean {
  return (
    isNonArrayObject(value) &&
    typeof value.id === 'string' &&
    typeof value.sha === 'string'
  )
}

const PLAN_SOURCE_MISS_REASONS = new Set<string>([
  'descriptor-ambiguous',
  'descriptor-missing',
  'page-anchor-mismatch',
  'gate-refused',
  'parameter-unbound',
  'non-replayable-action',
])

// A demotion outside this set is a malformed document; never loosen the predicate for it.
const PLAN_SOURCE_DEMOTIONS = new Set<string>([
  'body-unreadable',
  'body-unparseable',
  'body-empty',
])

const TEST_BUG_SUBTYPES = new Set<string>([
  'stale_selector',
  'outdated_flow',
  'bad_assertion',
  'wrong_expected_value',
])

// Must match the wire's `int().nonnegative()`, or an admitted value fails the Knowledge tab's read.
function isOrdinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function hasProcedureStepIndexShape(value: unknown): boolean {
  return isNonArrayObject(value) && isOrdinal(value.procedureStepIndex)
}

// Canary projection reads the replay guard's fold, so an admitted replay carries it.
function hasCompletePlanSourceShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  if (typeof value.procedureId !== 'string' || value.procedureId.length === 0) {
    return false
  }
  if (value.kind === 'procedure-hint') {
    // Absence stays legal (an ordinary hint carries no demotion); a PRESENT demotion must
    // sit inside the closed union so demotion counts are trustworthy.
    if ('demotion' in value) {
      return typeof value.demotion === 'string' && PLAN_SOURCE_DEMOTIONS.has(value.demotion)
    }
    return true
  }
  if (value.kind !== 'procedure-replay') return false

  const guard = value.guard
  if (!isNonArrayObject(guard)) return false
  if (!isOrdinal(guard.checksPassed) || !isOrdinal(guard.total)) {
    return false
  }
  if ('miss' in guard) {
    const miss = guard.miss
    if (!isNonArrayObject(miss)) return false
    if (!isOrdinal(miss.procedureStepIndex)) return false
    if (
      typeof miss.reason !== 'string' ||
      !PLAN_SOURCE_MISS_REASONS.has(miss.reason)
    ) {
      return false
    }
  }
  if ('executionFailure' in guard && !hasProcedureStepIndexShape(guard.executionFailure)) {
    return false
  }
  if ('verifierRejection' in guard && !hasProcedureStepIndexShape(guard.verifierRejection)) {
    return false
  }
  if ('flow' in value) {
    // The flow cursor is admitted only as non-negative integers, the domain the wire declares.
    const flow = value.flow
    if (!isNonArrayObject(flow)) return false
    if (!isOrdinal(flow.cursor) || !isOrdinal(flow.length)) return false
  }
  return true
}

// Candidate emission walks the verdict's evidence, so an admitted verdict carries it in full.
function hasCompleteRootCauseShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  if (!isVerdictClass(value.class)) return false
  if (
    value.producer !== 'deterministic-classifier' &&
    value.producer !== 'analyze-run'
  ) {
    return false
  }
  if (typeof value.confidence !== 'number') return false

  const evidence = value.evidence
  if (!isNonArrayObject(evidence)) return false
  if (
    !Array.isArray(evidence.citedSteps) ||
    !evidence.citedSteps.every((step) => typeof step === 'number')
  ) {
    return false
  }
  if (
    !Array.isArray(evidence.citedAnchors) ||
    !evidence.citedAnchors.every(isAnchorShape)
  ) {
    return false
  }
  if (
    !Array.isArray(evidence.citedArtifacts) ||
    !evidence.citedArtifacts.every(isArtifactRefShape)
  ) {
    return false
  }
  if (typeof evidence.rationale !== 'string') return false

  if (typeof value.memoryMisdirectionRuledOut !== 'boolean') return false
  if (typeof value.perTest !== 'number') return false

  // A present `memoryOnPath` must be well formed; a malformed one is refused, not stripped.
  if (!hasMemoryOnPathShape(value)) return false

  if ('attribution' in value) {
    const attribution = value.attribution
    if (!isNonArrayObject(attribution)) return false
    if (!Array.isArray(attribution.records) || !Array.isArray(attribution.anchors)) {
      return false
    }
  }
  if ('subtype' in value) {
    if (value.class !== 'test_bug') return false
    if (
      typeof value.subtype !== 'string' ||
      !TEST_BUG_SUBTYPES.has(value.subtype)
    ) {
      return false
    }
  }
  return true
}

// The extraction fold reads `name` and `value` as strings; absence and an empty array stay legal.
function hasCompleteInterpolatedVariablesShape(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (member) =>
        isNonArrayObject(member) &&
        typeof member.name === 'string' &&
        typeof member.value === 'string',
    )
  )
}

// Delegates to the zod schema so this guard cannot drift from the contract its producer validates.
function hasCompleteRetrievalTraceShape(value: unknown): boolean {
  return ServedRetrievalTraceV1Schema.safeParse(value).success
}

// Delegates to the rung schema; an open string would reach a surface with no rendering for it.
function hasCompleteRetrievalRungShape(value: unknown): boolean {
  return RecordedRetrievalRungSchema.safeParse(value).success
}

function isOneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && values.includes(value)
}

function hasCompleteConditionRecordShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  const file = value.file
  return (
    typeof value.quote === 'string' &&
    typeof value.reason === 'string' &&
    isOneOf(CONDITION_VERDICTS, value.verdict) &&
    (!('judged' in value) || isOneOf(CONDITION_VERDICTS, value.judged)) &&
    (!('guard' in value) || isOneOf(CONDITION_GUARDS, value.guard)) &&
    (!('needs' in value) || isOneOf(CONDITION_NEEDS, value.needs)) &&
    Array.isArray(value.citations) &&
    value.citations.every(
      (citation) =>
        isNonArrayObject(citation) &&
        isOneOf(CITATION_SOURCES, citation.source) &&
        typeof citation.quote === 'string' &&
        (typeof citation.found === 'boolean' || citation.found === 'unchecked'),
    ) &&
    (!('file' in value) ||
      (isNonArrayObject(file) &&
        isOneOf(['match', 'differs'], file.name) &&
        isOneOf(['match', 'differs', 'unverified'], file.content) &&
        (!('firstDifference' in file) || typeof file.firstDifference === 'string')))
  )
}

// Checked by hand because the block has no runtime schema; every literal must be one readers know.
function hasCompleteConditionVerdictsShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  const openDialogs = value.openDialogs
  return (
    isOneOf(CONDITION_ENDINGS, value.ending) &&
    Array.isArray(value.conditions) &&
    value.conditions.every(hasCompleteConditionRecordShape) &&
    (!('openDialogs' in value) ||
      (Array.isArray(openDialogs) &&
        openDialogs.every(
          (dialog) =>
            isNonArrayObject(dialog) &&
            typeof dialog.name === 'string' &&
            isOneOf(
              ['bears-on-condition', 'requested', 'unrelated', 'unaccounted'],
              dialog.account,
            ),
        )))
  )
}

function hasCompleteStepShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false

  const servedBrief = value.servedBrief
  const verifierVerdict = value.verifierVerdict

  return (
    typeof value.stepIndex === 'number' &&
    typeof value.stepText === 'string' &&
    (value.cacheStatus === 'hit' ||
      value.cacheStatus === 'miss' ||
      value.cacheStatus === 'bypass' ||
      value.cacheStatus === 'disabled') &&
    isNonArrayObject(servedBrief) &&
    Array.isArray(servedBrief.channel1) &&
    servedBrief.channel1.every(isNonArrayObject) &&
    Array.isArray(value.subActions) &&
    value.subActions.every(hasCompleteSubActionShape) &&
    isNonArrayObject(verifierVerdict) &&
    typeof verifierVerdict.pass === 'boolean' &&
    typeof verifierVerdict.reasoning === 'string' &&
    (!('planSource' in value) || hasCompletePlanSourceShape(value.planSource)) &&
    (!('interpolatedVariables' in value) ||
      hasCompleteInterpolatedVariablesShape(value.interpolatedVariables)) &&
    (!('retrievalTrace' in value) ||
      hasCompleteRetrievalTraceShape(value.retrievalTrace)) &&
    (!('retrievalRung' in value) || hasCompleteRetrievalRungShape(value.retrievalRung)) &&
    (!('conditionVerdicts' in value) ||
      hasCompleteConditionVerdictsShape(value.conditionVerdicts))
  )
}

/** Strict only for the new block: historical handoff shapes retain their existing rules. */
function hasRerunOriginShape(value: unknown, member: Record<string, unknown>, runId: string): boolean {
  if (!isNonArrayObject(value)) return false
  const safeIndex = (index: unknown): index is number =>
    typeof index === 'number' && Number.isSafeInteger(index) && index >= 0
  const digest = (hash: unknown): hash is string =>
    typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)
  if (Object.keys(value).some(key => !['attempt', 'outcome', 'rootCause', 'evidenceDigest', 'decisions'].includes(key))) return false
  if (member.isRerun !== true || !safeIndex(member.rerunAttempt) ||
      !safeIndex(value.attempt) || value.attempt >= member.rerunAttempt) return false
  if (value.outcome !== 'failed' && value.outcome !== 'timeout') return false
  if (!safeIndex(member.testIndex) || !digest(value.evidenceDigest) || !Array.isArray(value.decisions)) return false
  if ('rootCause' in value) {
    const root = value.rootCause
    if (!hasCompleteRootCauseShape(root) || !isNonArrayObject(root) ||
        root.producer !== 'deterministic-classifier' || root.perTest !== member.testIndex ||
        typeof root.confidence !== 'number' || !Number.isFinite(root.confidence) ||
        root.confidence < 0 || root.confidence > 1 ||
        !isNonArrayObject(root.evidence) || !Array.isArray(root.evidence.citedSteps) ||
        !root.evidence.citedSteps.every(safeIndex)) return false
  }
  const seen = new Set<string>()
  try {
    for (const decision of value.decisions) {
      if (!isNonArrayObject(decision) || Object.keys(decision).some(key =>
        !['runId', 'testId', 'testIndex', 'stepIndex', 'decisionOrdinal', 'screenStateHash', 'evidenceDigest', 'evidence'].includes(key))) return false
      if (decision.runId !== runId || decision.testId !== member.testId ||
          decision.testIndex !== member.testIndex || !safeIndex(decision.stepIndex) ||
          !safeIndex(decision.decisionOrdinal) || !digest(decision.screenStateHash) ||
          !digest(decision.evidenceDigest) || !hasCompleteStepShape(decision.evidence)) return false
      const step = decision.evidence as StepEvidence
      if (step.stepIndex !== decision.stepIndex || 'rerunOrigin' in step || 'firstFailedAttempt' in step) return false
      const action = step.subActions[decision.decisionOrdinal]
      if (action === undefined || typeof action.result?.success !== 'boolean' ||
          screenStateHash(action.stateBefore) !== decision.screenStateHash) return false
      const key = `${decision.stepIndex}:${decision.decisionOrdinal}`
      if (seen.has(key)) return false
      seen.add(key)
      const { screenStateHash: _stateHash, evidenceDigest, ...facts } = decision
      if (sha256hex(canonicalJson(facts)) !== evidenceDigest) return false
    }
    const { evidenceDigest, ...facts } = value
    return sha256hex(canonicalJson(facts)) === evidenceDigest
  } catch {
    // Malformed/cyclic observation facts cannot establish an evidence identity.
    return false
  }
}

function hasCompleteTestShape(value: unknown, runId: string): boolean {
  if (!isNonArrayObject(value)) return false

  return (
    typeof value.testId === 'string' &&
    typeof value.testName === 'string' &&
    value.testName.length > 0 &&
    typeof value.filePath === 'string' &&
    value.filePath.length > 0 &&
    typeof value.testIndex === 'number' &&
    (value.outcome === 'passed' ||
      value.outcome === 'failed' ||
      value.outcome === 'healed' ||
      value.outcome === 'timeout' ||
      value.outcome === 'cancelled' ||
      value.outcome === 'skipped') &&
    Array.isArray(value.steps) &&
    value.steps.every(hasCompleteStepShape) &&
    (!('rootCause' in value) || hasCompleteRootCauseShape(value.rootCause)) &&
    // Only literal `true` is legal, or a hand-edited handoff reads differently at two consumers.
    (!('quarantined' in value) || value.quarantined === true) &&
    // Persisted rerun fields are present-implies-valid.
    (!('isRerun' in value) || value.isRerun === true) &&
    (!('rerunAttempt' in value) ||
      (typeof value.rerunAttempt === 'number' &&
        Number.isInteger(value.rerunAttempt) &&
        value.rerunAttempt >= 1)) &&
    (!('rerunOrigin' in value) || hasRerunOriginShape(value.rerunOrigin, value, runId))
  )
}

// Every field is a required non-empty string; an entry without its identity cannot join a test.
function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

const PLANNER_LIMITS_RECORD_KEYS = new Set(['maxActions', 'maxPlanningTurns', 'perTest'])
const PLANNER_LIMITS_PER_TEST_KEYS = new Set(['testName', 'filePath', 'maxActions', 'maxPlanningTurns'])

function hasPlannerLimitsPerTestShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  return (
    Object.keys(value).every((key) => PLANNER_LIMITS_PER_TEST_KEYS.has(key)) &&
    typeof value.testName === 'string' &&
    typeof value.filePath === 'string' &&
    isPositiveSafeInteger(value.maxActions) &&
    isPositiveSafeInteger(value.maxPlanningTurns)
  )
}

// Must match `PlannerLimitsRecordSchema`, the strict wire an admitted record is copied onto.
function hasPlannerLimitsRecordShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  return (
    Object.keys(value).every((key) => PLANNER_LIMITS_RECORD_KEYS.has(key)) &&
    isPositiveSafeInteger(value.maxActions) &&
    isPositiveSafeInteger(value.maxPlanningTurns) &&
    (!('perTest' in value) ||
      (Array.isArray(value.perTest) && value.perTest.every(hasPlannerLimitsPerTestShape)))
  )
}

function hasQuarantineAppliedShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  return (
    typeof value.product === 'string' &&
    value.product.length > 0 &&
    typeof value.filePath === 'string' &&
    value.filePath.length > 0 &&
    typeof value.testName === 'string' &&
    value.testName.length > 0 &&
    typeof value.expiresAt === 'string' &&
    value.expiresAt.length > 0
  )
}

// Validates every field a consumer dereferences; deep evidence no consumer reads stays unchecked.
function hasCompleteHandoffShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false

  const scope = value.scope
  const configDigests = value.configDigests

  return (
    typeof value.schemaVersion === 'number' &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    isNonArrayObject(scope) &&
    (scope.tier === 'global' ||
      scope.tier === 'product' ||
      scope.tier === 'suite' ||
      scope.tier === 'test') &&
    typeof scope.key === 'string' &&
    scope.key.length > 0 &&
    typeof value.buildOrdinal === 'number' &&
    (!('excludedFromOutcomes' in value) || value.excludedFromOutcomes === true) &&
    (!('gateRun' in value) || value.gateRun === true) &&
    (value.executionContext === 'local-interactive' ||
      value.executionContext === 'local-headless' ||
      value.executionContext === 'ci' ||
      value.executionContext === 'cloud') &&
    (value.aggregateVerdict === 'passed' ||
      value.aggregateVerdict === 'failed' ||
      value.aggregateVerdict === 'healed' ||
      value.aggregateVerdict === 'timeout' ||
      value.aggregateVerdict === 'cancelled') &&
    isNonArrayObject(configDigests) &&
    typeof configDigests.suiteConfigDigest === 'string' &&
    typeof configDigests.testConfigDigest === 'string' &&
    typeof value.startedAt === 'number' &&
    typeof value.endedAt === 'number' &&
    Array.isArray(value.tests) &&
    value.tests.every(test => hasCompleteTestShape(test, value.runId as string)) &&
    (!('quarantineApplied' in value) ||
      (Array.isArray(value.quarantineApplied) &&
        value.quarantineApplied.every(hasQuarantineAppliedShape))) &&
    (!('plannerLimits' in value) || hasPlannerLimitsRecordShape(value.plannerLimits))
  )
}

/**
 * The read side of the handoff version discipline: parse → version check → refuse any stamp
 * other than {@link CURRENT_HANDOFF_SCHEMA_VERSION} with a typed {@link HandoffVersionError}.
 * Pure — no fs; the runner-local fs leg delegates here. Every handoff consumer routes through
 * this one guard.
 */
export const guardCompletedRunHandoff = createVersionGuard<CompletedRunHandoff>({
  name: 'CompletedRunHandoff',
  current: CURRENT_HANDOFF_SCHEMA_VERSION,
  migrations: HANDOFF_MIGRATIONS,
  error: HandoffVersionError,
  shape: hasCompleteHandoffShape,
})
