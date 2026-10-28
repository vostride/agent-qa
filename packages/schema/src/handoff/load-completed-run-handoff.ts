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
  // 2026-10-19 (444.1-08, D-14): curation dereferences the dispatch pair as it does the planner's.
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

/**
 * Mirrors the six-kind Anchor union (discriminant `t` plus its payload) so every
 * guard-admitted `citedAnchors` member survives normalizeAnchor in the curator drain (WR-02).
 */
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

/**
 * Requires string `id`/`sha` so artifact descriptor mapping is total (`ref.id.startsWith`
 * runs once the sha regex passes); hex-format enforcement stays the consumer's filter (WR-02).
 */
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

/**
 * The closed `StepPlanSource` procedure-hint demotion union (G-381-4 / D-12). Kept verbatim
 * beside the miss-reason set: a demotion outside it is a malformed document, never something
 * to loosen the predicate for.
 */
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

/**
 * The loader's spelling of the wire's `z.number().int().nonnegative()` — the domain
 * `RunKnowledgePlanSourceSchema` (`../functions/runs`) declares for EVERY numeric member of a
 * replay plan source: `flow.cursor`, `flow.length`, `guard.checksPassed`, `guard.total` and the
 * three `procedureStepIndex` slots.
 *
 * The two predicates must never disagree. `planSourceOf` (agent `ops/runs-knowledge.ts`) picks an
 * admitted value straight onto that strict wire, so a member this loader admits and the wire
 * refuses reaches `spec.output.parse` as a thrown read and the Knowledge tab renders
 * `read_failed` for the run — REVIEW WR-04, structurally the CR-01 class (a producer value
 * reaching a stricter declaration) narrowed to "declared with a narrower domain than the
 * admission predicate". A handoff carrying a negative cursor is malformed, not historical: the
 * runner writes only indices and counts here (`recordProcedureReplaySource`, runner
 * `loop/index.ts`), so nothing already on disk is refused by reading the wire's domain.
 */
function isOrdinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function hasProcedureStepIndexShape(value: unknown): boolean {
  return isNonArrayObject(value) && isOrdinal(value.procedureStepIndex)
}

/**
 * Validates a present `planSource` against the complete discriminated StepPlanSource
 * union (D-12): canary projection dereferences the replay guard's fold fields, so an
 * admitted procedure-replay source must carry them in full (CR-02).
 */
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
    // F-381-51-1 · D-09 / 407-12 / 407-20: the additive flow cursor is admitted only
    // well-formed — present ⇒ {cursor, length} both NON-NEGATIVE INTEGERS, the domain the wire
    // declares (`RunKnowledgePlanSourceSchema.flow`). Fail-closed on any other shape (the
    // CR-02/381-36 strictness is never loosened for a new member).
    const flow = value.flow
    if (!isNonArrayObject(flow)) return false
    if (!isOrdinal(flow.cursor) || !isOrdinal(flow.length)) return false
  }
  return true
}

/**
 * Validates a present `rootCause` against the complete Verdict shape: candidate
 * emission traverses `evidence.citedSteps`/`citedAnchors`/`citedArtifacts`/`rationale`,
 * so an admitted verdict must carry them in consumer-traversable form (CR-02).
 */
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

/**
 * Validates a present `interpolatedVariables` at the depth its one consumer dereferences
 * (381 G-381-3): the procedure-extraction emit fold applies exact string equality against
 * `value` to classify a trajectory value slot and copies `name` VERBATIM as the forced
 * parameter name — so every admitted member must be a non-array object carrying string
 * `name` AND string `value`, and nothing deeper exists to validate. Absence stays legal
 * (the field is additive-optional; a step that interpolated nothing omits it), and an
 * empty array is legal emptiness, distinct from malformed.
 */
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

/**
 * Validates a present `retrievalTrace` (387 D-13/D-14) by DELEGATING to the one schema that
 * declares it, rather than restating its fields here.
 *
 * Every other predicate in this file is hand-rolled because its subject is a TypeScript
 * interface with no runtime declaration anywhere. The trace is not — it ships as a zod
 * schema — and a second hand-rolled spelling of it would be a guard patterned on what it
 * guards, free to drift from the contract the producer validates against.
 *
 * Present-implies-valid, and absence stays legal: a pre-387 run has no trace and never will
 * (that absence is what D-15's typed no-trace answer is FOR). Presence is admitted only in
 * consumer-traversable form because the why-verb dereferences every line's record, leg,
 * rank and score to answer with — the same discipline `planSource` and
 * `interpolatedVariables` carry.
 */
function hasCompleteRetrievalTraceShape(value: unknown): boolean {
  return ServedRetrievalTraceV1Schema.safeParse(value).success
}

/**
 * Validates a present `retrievalRung` (407 D-13) by DELEGATING to the schema that declares it,
 * for the same reason the trace predicate above delegates: the rung ships as a zod schema, and a
 * second hand-rolled spelling here would be a guard free to drift from the contract its producer
 * validates against.
 *
 * Present-implies-valid, and absence stays legal: a pre-407 run has no rung and never will, and
 * neither does a run that bound no knowledge reader. Presence is admitted only in the closed
 * two-word form the banner renders and `doctor` grades — an open string here would reach a
 * surface that has no rendering for it.
 */
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

/**
 * Validates a present `conditionVerdicts` (439 D-07) by hand: the block is a TypeScript DTO with
 * no runtime schema, and every reader (the router, the root-cause classifier, analyze-run, the
 * evidence diet) walks its conditions, verdicts and dialogs through `stepOutcomeUnproven`.
 *
 * Present-implies-valid, and absence stays legal: a pre-439 run has no block, and neither does a
 * step that ended before any verifier judgment. Presence is admitted only in consumer-traversable
 * form, with every verdict, guard, need, citation source and dialog account one of its declared
 * literals, so no reader meets a value it has no reading for.
 */
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
    // 390 D-14: only the literal marker is legal. A truthy-but-not-true value would let a
    // hand-edited handoff read as quarantined at one consumer and not at another.
    (!('quarantined' in value) || value.quarantined === true) &&
    // 2026-09-07, 418 D-09: persisted rerun fields are present-implies-valid.
    (!('isRerun' in value) || value.isRerun === true) &&
    (!('rerunAttempt' in value) ||
      (typeof value.rerunAttempt === 'number' &&
        Number.isInteger(value.rerunAttempt) &&
        value.rerunAttempt >= 1)) &&
    (!('rerunOrigin' in value) || hasRerunOriginShape(value.rerunOrigin, value, runId))
  )
}

/**
 * 390 D-16: one applied-entry record, at the depth consumers traverse — the three identity legs
 * plus the expiry that says how long the disposition was licensed for. Every field is a required
 * non-empty string; an entry missing its identity could never be joined back to a test.
 */
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

/**
 * 436 D-06: the loader's spelling of `PlannerLimitsRecordSchema` (`../functions/runs`). The
 * acknowledgement copies an admitted record onto that strict wire, so the two must never disagree.
 */
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

/**
 * Guarantees every required root field plus the required fields on each per-test outcome
 * and traversed step before a handoff reaches direct consumers, including the complete
 * discriminated shapes of the two traversed optional blocks — `planSource` and `rootCause`
 * (CR-02), including a present `planSource.demotion` on the procedure-hint arm, which must
 * sit inside the closed body-unreadable/body-unparseable/body-empty union while its absence
 * stays legal (G-381-4) — the string `name`/`value` of every present `interpolatedVariables` member, the
 * pair the emit fold value-matches and name-copies (G-381-3 capture half; absence and
 * emptiness both stay legal) — the element shapes of the consumer-traversed arrays — every `subActions` member
 * is dereferenceable through `plannedAction`, `grounding.attempts` (flatMapped by
 * resolvedActionRefs for every subAction), and `stateBefore.elements[]` down to the
 * string values consumers apply string operations to: string `role`/`nameNormalized`,
 * all-string `attributes`/`labels` member values, and string-if-present urls on BOTH
 * `stateBefore` and `stateAfter` — the two legs classifySubActionRoute reads
 * (CR-01/WR-01 grounding-depth and value-level closure; round-9 CR-01 stateAfter-url
 * closure); every `servedBrief.channel1`
 * member is a non-array object — and the `rootCause.evidence` members: `citedAnchors`
 * satisfy the six-kind Anchor union and `citedArtifacts` carry string id/sha (WR-02).
 * Only genuinely untraversed deep evidence — verified untraversed at the consumers'
 * dereference sites (handoff-anchors.ts, emit-candidates.ts, emit-canary-outcomes.ts,
 * normalize-anchor.ts) — stays unvalidated at this load boundary: workingMemory,
 * decision context, stagnation, cycle, planning failure, stateAfter interiors beyond
 * url, `grounding.descriptor` and attempt interiors (stage/outcome/resolvedRef value
 * types), and element state/bounds/hierarchy; element name/value stay unvalidated as
 * read-but-crash-safe reads (2026-10-15, 441-25: the curation capture copy that carried
 * them is gone).
 */
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
