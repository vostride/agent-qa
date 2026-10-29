import { isAbsolute, join } from 'node:path'

import { z } from 'zod'

import {
  LOCAL_CURATION_CAPABILITIES,
  type CurationCandidateProjection,
  type CurationProjectionArtifactSource,
  type EnqueueCurationCandidateProjectionOutcome,
} from '@vostride/agent-qa-agent-local'
import { RUN_EVIDENCE_BLOBS_SUBDIR } from '@vostride/agent-qa-runner-local'
import {
  actedPair,
  canonicalJson,
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  deriveEvidenceToken,
  maskPayloadStrings,
  procedureJsonValueSchema,
  type Anchor,
  type ArtifactRef,
  type CautionRootCauseClass,
  type CompletedRunHandoff,
  type DistilledObservation,
  type FactSubtype,
  type MaskFn,
  type PerTestOutcome,
  type Platform,
  type ProcedureJsonValue,
  type ScreenState,
  type StepEvidence,
  type SubActionEvidence,
} from '@vostride/agent-qa-schema'

import {
  actedStep,
  actionRefs,
  classifySubActionRoute,
  elementAnchor,
  elementNaturalKey,
  exercisedAnchors,
  resolvedElementEvidence,
  uniqueAnchors,
  type ResolvedElementEvidence,
} from './handoff-anchors.js'

export const LEARNABLE_CAUTION_ROOT_CAUSES = [
  'environment',
  'timeout',
  'flake',
] as const satisfies readonly CautionRootCauseClass[]

interface MeasurementSeed {
  metric: string
  value: string
}

type CurationArtifactDescriptor =
  CurationCandidateProjection['artifactDescriptors'][number]

const SHA256_HEX = /^[0-9a-f]{64}$/

function actedStateOf(subAction: SubActionEvidence | undefined): ScreenState | undefined {
  return subAction === undefined ? undefined : actedPair(subAction).stateBefore
}

function observationId(
  handoff: CompletedRunHandoff,
  testIndex: number,
  stepIndex: number,
): string {
  return `${handoff.runId}:test-${testIndex}:step-${stepIndex}`
}

function observationPlatform(platform: Platform): 'web' | 'mobile' {
  return platform === 'web' ? 'web' : 'mobile'
}

function artifactDescriptor(
  ref: ArtifactRef,
  stepIndex: number,
  forcedRole?: CurationArtifactDescriptor['role'],
): CurationArtifactDescriptor {
  const role = forcedRole
    ?? (ref.id.startsWith('decision-screenshot:')
      ? 'screenshot'
      : ref.id.startsWith('dom-snapshot:')
        ? 'dom-snapshot'
        : ref.id.startsWith('ax-snapshot:')
          ? 'ax-snapshot'
          : 'opaque-evidence')
  const originalName = role === 'screenshot'
    ? 'decision-screenshot.png'
    : role === 'dom-snapshot'
      ? 'dom-snapshot.json'
      : role === 'ax-snapshot'
        ? 'ax-snapshot.json'
        : 'opaque-evidence.bin'
  return { ref, stepIndex, role, originalName }
}

function artifactDescriptorsForRefs(
  refs: readonly ArtifactRef[],
  stepIndex: number,
): CurationArtifactDescriptor[] {
  const seen = new Set<string>()
  const descriptors: CurationArtifactDescriptor[] = []
  for (const ref of refs) {
    if (!SHA256_HEX.test(ref.sha) || seen.has(ref.id)) continue
    seen.add(ref.id)
    descriptors.push(artifactDescriptor(ref, stepIndex))
  }
  return descriptors
}

function stepArtifactDescriptors(step: StepEvidence): CurationArtifactDescriptor[] {
  const descriptors = step.subActions.flatMap((subAction) => [
    ...(subAction.decisionScreenshotRef === undefined
      || !SHA256_HEX.test(subAction.decisionScreenshotRef.sha)
      ? []
      : [artifactDescriptor(
          subAction.decisionScreenshotRef,
          step.stepIndex,
          'screenshot',
        )]),
    ...artifactDescriptorsForRefs(subAction.artifactRefs ?? [], step.stepIndex),
  ])
  const seen = new Set<string>()
  return descriptors.filter((descriptor) => {
    if (seen.has(descriptor.ref.id)) return false
    seen.add(descriptor.ref.id)
    return true
  })
}

// Only an anchor's text member is masked; `flow.name` is a test id.
function maskedAnchor(anchor: Anchor, mask: MaskFn | undefined): Anchor {
  switch (anchor.t) {
    case 'page':
      return { ...anchor, route: maskedProse(anchor.route, mask) }
    case 'el':
      return { ...anchor, name: maskedProse(anchor.name, mask) }
    case 'selector':
      return { ...anchor, literal: maskedProse(anchor.literal, mask) }
    case 'error':
      return { ...anchor, message: maskedProse(anchor.message, mask) }
    case 'flow':
    case 'platform':
      return anchor
  }
}

function maskedObservation(
  observation: DistilledObservation,
  mask: MaskFn | undefined,
): DistilledObservation {
  const { flow, surface, element, locator, error } = observation
  return {
    ...observation,
    step: { ...observation.step, naturalKey: maskedProse(observation.step.naturalKey, mask) },
    ...(flow?.precedes === undefined
      ? {}
      : { flow: { ...flow, precedes: maskedProse(flow.precedes, mask) } }),
    ...(surface === undefined
      ? {}
      : { surface: { ...surface, naturalKey: maskedProse(surface.naturalKey, mask) } }),
    ...(element === undefined
      ? {}
      : { element: { naturalKey: maskedProse(element.naturalKey, mask) } }),
    ...(locator === undefined
      ? {}
      : { locator: { selector: maskedProse(locator.selector, mask) } }),
    ...(error === undefined
      ? {}
      : { error: { ...error, naturalKey: maskedProse(error.naturalKey, mask) } }),
  }
}

function commonFields(
  handoff: CompletedRunHandoff,
  input: {
    kind: CurationCandidateProjection['kind']
    subtype?: FactSubtype
    rootCauseClass?: CautionRootCauseClass
    anchors: Anchor[]
    summarySeed: string
    bodySeed: string
    observations: DistilledObservation[]
    attributingObservationId: string
    artifactDescriptors: CurationArtifactDescriptor[]
  },
  mask: MaskFn | undefined,
): CurationCandidateProjection {
  const anchors = uniqueAnchors(input.anchors.map((anchor) => maskedAnchor(anchor, mask)))
  return {
    sourceRunId: handoff.runId,
    scope: handoff.scope,
    buildOrdinal: handoff.buildOrdinal,
    executionContext: handoff.executionContext,
    kind: input.kind,
    ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
    ...(input.rootCauseClass === undefined
      ? {}
      : { rootCauseClass: input.rootCauseClass }),
    anchors,
    summarySeed: input.summarySeed,
    bodySeed: input.bodySeed,
    distilledObservations: input.observations.map((observation) =>
      maskedObservation(observation, mask)),
    evidenceToken: deriveEvidenceToken({
      attributingObservationId: input.attributingObservationId,
      anchor: anchors[0]!,
      buildOrdinal: handoff.buildOrdinal,
    }),
    attributingObservationId: input.attributingObservationId,
    artifactDescriptors: input.artifactDescriptors,
    emittedAt: new Date(handoff.endedAt).toISOString(),
  }
}

function factSubtype(
  evidence: ResolvedElementEvidence,
): { subtype: FactSubtype; route?: string } {
  const classification = classifySubActionRoute(evidence.subAction)
  if (classification.navigated && classification.route !== undefined) {
    return { subtype: 'navigational', route: classification.route }
  }
  return evidence.locator === undefined
    ? { subtype: 'behavioral' }
    : { subtype: 'selector' }
}

function projectFact(
  handoff: CompletedRunHandoff,
  test: PerTestOutcome,
  step: StepEvidence,
  mask: MaskFn | undefined,
): CurationCandidateProjection | undefined {
  if (!step.verifierVerdict.pass) return undefined
  const resolved = resolvedElementEvidence(actedStep(step))
  if (resolved.length !== 1) return undefined

  const evidence = resolved[0]!
  const id = observationId(handoff, test.testIndex, step.stepIndex)
  const before = actedPair(evidence.subAction).stateBefore
  const platform = before.platform
  const classification = factSubtype(evidence)
  const element = elementAnchor(evidence)
  const selector = evidence.locator === undefined
    ? undefined
    : ({ t: 'selector', literal: evidence.locator } satisfies Anchor)
  const page = classification.route === undefined
    ? undefined
    : ({ t: 'page', route: classification.route } satisfies Anchor)
  const primary = page ?? selector ?? element
  const anchors = uniqueAnchors([
    primary,
    element,
    ...(selector === undefined ? [] : [selector]),
    { t: 'platform', platform },
    ...(page === undefined ? [] : [page]),
  ])
  const observation: DistilledObservation = {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: id, ordinal: step.stepIndex },
    platform: observationPlatform(platform),
    test: { id: test.testId },
    ...(before.url === undefined
      ? {}
      : {
          surface: {
            kind: 'page' as const,
            naturalKey: classification.route ?? before.url,
          },
        }),
    element: { naturalKey: elementNaturalKey(evidence) },
    ...(evidence.locator === undefined
      ? {}
      : { locator: { selector: evidence.locator } }),
    observedAtOrdinal: handoff.buildOrdinal,
  }

  const subject = `${evidence.element.role} "${evidence.element.nameNormalized}"`
  const summarySeed = classification.subtype === 'selector'
    ? `${subject} selector ${evidence.locator}`
    : classification.subtype === 'navigational'
      ? `${subject} navigates to ${classification.route}`
      : `${subject} resolved as a verified element`
  const bodySeed = classification.subtype === 'selector'
    ? `Verified ${subject} at ${evidence.locator}.`
    : classification.subtype === 'navigational'
      ? `Verified ${subject} before navigation to ${classification.route}.`
      : `Verified ${subject} from the recorded screen state.`

  return commonFields(
    handoff,
    {
      kind: 'fact',
      subtype: classification.subtype,
      anchors,
      summarySeed: maskedProse(summarySeed, mask),
      bodySeed: maskedProse(bodySeed, mask),
      observations: [observation],
      attributingObservationId: id,
      artifactDescriptors: stepArtifactDescriptors(step),
    },
    mask,
  )
}

function measurementSeeds(step: StepEvidence): MeasurementSeed[] {
  const reported = step.reportedValue === undefined
    ? []
    : [{ metric: 'reported-value', value: step.reportedValue.value }]
  const asserted =
    step.assertOutcome === undefined || !step.assertOutcome.passed
      ? []
      : [
          {
            metric: `assert-value:${step.assertOutcome.source}`,
            value: step.assertOutcome.actual === null
              ? 'null'
              : step.assertOutcome.actual ?? 'undefined',
          },
        ]
  return [...reported, ...asserted]
}

function projectMeasurements(
  handoff: CompletedRunHandoff,
  test: PerTestOutcome,
  step: StepEvidence,
  mask: MaskFn | undefined,
): CurationCandidateProjection[] {
  if (!step.verifierVerdict.pass) return []
  const firstSubAction = step.subActions[0]
  if (firstSubAction === undefined) return []
  const resolved = resolvedElementEvidence(actedStep(step))
  const singleElement = resolved.length === 1 ? resolved[0] : undefined
  const platform = actedPair(firstSubAction).stateBefore.platform
  const id = observationId(handoff, test.testIndex, step.stepIndex)

  return measurementSeeds(step).map((measurement) => {
    const metricAnchor = {
      t: 'flow' as const,
      name: `measurement:${measurement.metric}`,
    }
    const anchors = uniqueAnchors([
      ...(singleElement === undefined ? [] : [elementAnchor(singleElement)]),
      metricAnchor,
      { t: 'platform', platform },
    ])
    const observation: DistilledObservation = {
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
      step: { naturalKey: id, ordinal: step.stepIndex },
      platform: observationPlatform(platform),
      test: { id: test.testId },
      flow: { name: measurement.metric },
      ...(singleElement === undefined
        ? {}
        : { element: { naturalKey: elementNaturalKey(singleElement) } }),
      observedAtOrdinal: handoff.buildOrdinal,
    }
    return commonFields(
      handoff,
      {
        kind: 'fact',
        subtype: 'measurement',
        anchors,
        summarySeed: maskedProse(`${measurement.metric} measured as ${measurement.value}`, mask),
        bodySeed: maskedProse(`Verified ${measurement.metric} value: ${measurement.value}.`, mask),
        observations: [observation],
        attributingObservationId: id,
        artifactDescriptors: stepArtifactDescriptors(step),
      },
      mask,
    )
  })
}

function isLearnableCaution(
  value: string,
): value is CautionRootCauseClass {
  return (LEARNABLE_CAUTION_ROOT_CAUSES as readonly string[]).includes(value)
}

function projectCaution(
  handoff: CompletedRunHandoff,
  test: PerTestOutcome,
  mask: MaskFn | undefined,
): CurationCandidateProjection | undefined {
  const rootCause = test.rootCause
  if (rootCause === undefined || !isLearnableCaution(rootCause.class)) return undefined
  const stepIndex = rootCause.evidence.citedSteps[0] ?? 0
  const id = observationId(handoff, test.testIndex, stepIndex)
  const fallbackAnchor: Anchor = {
    t: 'error',
    message: `${rootCause.class}: ${rootCause.evidence.rationale}`,
  }
  const anchors = uniqueAnchors([
    ...(rootCause.evidence.citedAnchors.length === 0
      ? [fallbackAnchor]
      : rootCause.evidence.citedAnchors),
    fallbackAnchor,
  ])
  const citedSteps = new Set(rootCause.evidence.citedSteps)
  const producingSteps = test.steps.filter((step) => citedSteps.has(step.stepIndex))
  const platform = actedStateOf(producingSteps[0]?.subActions[0])?.platform
  const observation: DistilledObservation = {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: id, ordinal: stepIndex },
    ...(platform === undefined ? {} : { platform: observationPlatform(platform) }),
    test: { id: test.testId },
    error: {
      naturalKey: `${rootCause.class}:${rootCause.evidence.rationale}`,
      rootCauseClass: rootCause.class,
    },
    observedAtOrdinal: handoff.buildOrdinal,
  }

  return commonFields(
    handoff,
    {
      kind: 'caution',
      rootCauseClass: rootCause.class,
      anchors,
      summarySeed: maskedProse(`${rootCause.class} caution for ${test.testId}`, mask),
      bodySeed: maskedProse(`${rootCause.class}: ${rootCause.evidence.rationale}`, mask),
      observations: [observation],
      attributingObservationId: id,
      artifactDescriptors: artifactDescriptorsForRefs(
        rootCause.evidence.citedArtifacts,
        stepIndex,
      ),
    },
    mask,
  )
}

// Targets carry exact names and row words, never ordinals; an older seed version is never authored.
export const PROCEDURE_TRAJECTORY_SEED_VERSION = 2

const trajectoryGuardTargetSchema = z
  .object({
    ref: z.string().min(1),
    role: z.string(),
    nameNormalized: z.string(),
    name: z.string(),
    row: z.string().optional(),
  })
  .strict()

const trajectoryCompositeValueSchema = z.union([
  z.null(),
  z.array(procedureJsonValueSchema),
  z.record(z.string(), procedureJsonValueSchema),
])

const trajectoryValueSlotSchema = z
  .object({
    // Boolean and numeric action fields are replay semantics; dropping one changes the replay.
    observed: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      trajectoryCompositeValueSchema,
    ]),
    source: z.enum(['literal', 'test-variable', 'masked-secret']),
    // The binding name behind this slot; `curator-author` names the covering parameter after it.
    sourceName: z.string().min(1).optional(),
  })
  .strict()

const trajectoryStepSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    instruction: z.string(),
    action: z
      .object({
        type: z.string().min(1),
        targets: z.record(z.string(), trajectoryGuardTargetSchema),
        values: z.record(z.string(), trajectoryValueSlotSchema),
      })
      .strict()
      .optional(),
    pageRoute: z.string().optional(),
  })
  .strict()

// Carried in the existing `bodySeed` string; the LLM only proposes segmentation and names.
export const procedureTrajectorySeedSchema = z
  .object({
    version: z.literal(PROCEDURE_TRAJECTORY_SEED_VERSION),
    flowName: z.string().min(1),
    steps: z.array(trajectoryStepSchema).min(2),
  })
  .strict()

export type ProcedureTrajectorySeed = z.infer<typeof procedureTrajectorySeedSchema>
export type ProcedureTrajectoryStep = ProcedureTrajectorySeed['steps'][number]

/** Fail-closed decode of a procedure candidate's code-built bodySeed trajectory. */
export function parseProcedureTrajectorySeed(
  bodySeed: string,
): ProcedureTrajectorySeed | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodySeed)
  } catch {
    return undefined
  }
  const result = procedureTrajectorySeedSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

// Secrets record as `[secret:NAME]` or `{{secret:NAME}}`; an old numbered placeholder is literal.
const MASKED_VALUE_PATTERN = /\{\{\s*secret:|\[secret:\w+\]/
const TEST_VARIABLE_PATTERN = /\{\{\s*env:/

// Mirrors the runner's secret patterns, because the curation fold may not import loop internals.
const SECRET_TEMPLATE_NAME_PATTERN = /^\{\{\s*secret:(\w+)\s*\}\}$/
const SECRET_MARKER_NAME_PATTERN = /^\[secret:(\w+)\]$/

/**
 * The secret a value IS: the name of a value that is exactly one `[secret:NAME]` marker or
 * one `{{secret:NAME}}` template. A value that merely contains one names nothing, because
 * replay fills the whole slot with the secret (CR-G01).
 */
function secretSourceName(observed: string): string | undefined {
  const name =
    SECRET_MARKER_NAME_PATTERN.exec(observed)?.[1]
    ?? SECRET_TEMPLATE_NAME_PATTERN.exec(observed)?.[1]
  // Case is preserved verbatim: the committed parameter name must equal the binding name
  // the consult-time availability set carries, and that set is case-sensitive.
  return name
}

// Exact equality only: replay substitutes the whole slot, so a containing value must stay literal.
function testVariableSourceName(
  raw: string,
  interpolated: readonly { name: string; value: string }[] | undefined,
): string | undefined {
  if (interpolated === undefined) return undefined
  let best: string | undefined
  for (const pair of interpolated) {
    if (pair.value !== raw) continue
    if (best === undefined || pair.name < best) best = pair.name
  }
  return best
}

// A secret binding needs the whole masked value to be one marker; other forms stay literal.
function trajectoryValueClassification(
  raw: string,
  masked: string,
  interpolated: readonly { name: string; value: string }[] | undefined,
): { source: 'literal' | 'test-variable' | 'masked-secret'; sourceName?: string } {
  const variableName = testVariableSourceName(raw, interpolated)
  if (variableName !== undefined) return { source: 'test-variable', sourceName: variableName }
  const secretName = secretSourceName(masked)
  if (secretName !== undefined) return { source: 'masked-secret', sourceName: secretName }
  if (MASKED_VALUE_PATTERN.test(raw) || MASKED_VALUE_PATTERN.test(masked)) {
    return { source: 'literal' }
  }
  if (TEST_VARIABLE_PATTERN.test(raw)) return { source: 'test-variable' }
  return { source: 'literal' }
}

const ACTION_REF_KEYS: readonly string[] = ['ref', 'fromRef', 'toRef']

function jsonRepresentable(
  value: unknown,
  ancestors: Set<object> = new Set(),
): value is ProcedureJsonValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false

  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      if (keys.some((key) => typeof key === 'symbol')) return false
      if (keys.length !== value.length + 1 || !keys.includes('length')) return false

      ancestors.add(value)
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)
          || !jsonRepresentable(descriptor.value, ancestors)
        ) {
          return false
        }
      }
      return true
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false

    ancestors.add(value)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
        || !jsonRepresentable(descriptor.value, ancestors)
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  } finally {
    ancestors.delete(value)
  }
}

function isCompositeJsonValue(
  value: ProcedureJsonValue,
): value is null | ProcedureJsonValue[] | { [key: string]: ProcedureJsonValue } {
  return value === null || typeof value === 'object'
}

// The caller's declared mask; absent only on a `no-masker` host.
function maskedProse(text: string, mask: MaskFn | undefined): string {
  return mask?.(text) ?? text
}

function completingSubAction(step: StepEvidence): SubActionEvidence | undefined {
  for (let index = step.subActions.length - 1; index >= 0; index -= 1) {
    const candidate = step.subActions[index]!
    if (actionRefs(candidate).length > 0) return candidate
  }
  return step.subActions.at(-1)
}

function tidyName(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

// Replay re-finds by role, exact name and stated row words, all masked; no position is written.
function trajectoryTargets(
  subAction: SubActionEvidence,
  mask: MaskFn | undefined,
): Record<string, z.infer<typeof trajectoryGuardTargetSchema>> {
  const targets: Record<string, z.infer<typeof trajectoryGuardTargetSchema>> = {}
  const { action: acted, stateBefore: before } = actedPair(subAction)
  const action = acted as unknown as Record<string, unknown>
  const stated = subAction.grounding?.stated
  let statedLaneFound = false
  for (const key of ACTION_REF_KEYS) {
    const ref = action[key]
    if (typeof ref !== 'string') continue
    const element = before.elements.find(
      (candidate) => candidate.ref === ref,
    )
    if (element === undefined) continue
    const statedLane = !statedLaneFound
      && stated !== undefined
      && tidyName(stated.name) === tidyName(element.name)
      && (stated.role === undefined || stated.role === element.role)
    if (statedLane) statedLaneFound = true
    const row = statedLane ? stated?.row?.trim() : undefined
    targets[key] = {
      ref,
      role: element.role,
      nameNormalized: maskedProse(element.nameNormalized, mask),
      name: maskedProse(element.name, mask),
      ...(row === undefined || row === '' ? {} : { row: maskedProse(row, mask) }),
    }
  }
  return targets
}

function trajectoryValues(
  subAction: SubActionEvidence,
  interpolated: readonly { name: string; value: string }[] | undefined,
  mask: MaskFn | undefined,
): Record<string, z.infer<typeof trajectoryValueSlotSchema>> | undefined {
  const values: Record<string, z.infer<typeof trajectoryValueSlotSchema>> = {}
  const action = actedPair(subAction).action as unknown as Record<string, unknown>
  for (const [key, raw] of Object.entries(action)) {
    if (key === 'type' || ACTION_REF_KEYS.includes(key)) continue
    // One lossy field invalidates the whole action; dropping a value would change replay.
    if (!jsonRepresentable(raw)) return undefined
    // A value equal to a declared value becomes a `{param}` ref; one containing it stays masked.
    const value = mask === undefined ? raw : maskPayloadStrings(raw, mask)
    const composite = isCompositeJsonValue(value)
    // The parameter union is scalar, so a composite holding masked material is rejected.
    if (composite) {
      const serialized = JSON.stringify(value)
      if (
        MASKED_VALUE_PATTERN.test(serialized)
        || TEST_VARIABLE_PATTERN.test(serialized)
      ) {
        return undefined
      }
    }
    values[key] = {
      observed: value,
      // Masking placeholders and variable templates are string phenomena. Numbers and booleans
      // therefore remain literal-source while preserving their original JSON scalar type; JSON
      // composites are admitted only after the fail-closed scan above and remain literal-source.
      ...(!composite && typeof value === 'string' && typeof raw === 'string'
        ? trajectoryValueClassification(raw, value, interpolated)
        : { source: 'literal' as const }),
    }
  }
  return values
}

function trajectoryStep(step: StepEvidence, mask: MaskFn | undefined): ProcedureTrajectoryStep {
  const completing = completingSubAction(step)
  const values =
    completing === undefined
      ? undefined
      : trajectoryValues(completing, step.interpolatedVariables, mask)
  // Replay checks the page guard before acting, so the route must describe the pre-action page.
  const route = actedStateOf(completing)?.url
  return {
    ordinal: step.stepIndex,
    instruction: maskedProse(step.stepText, mask),
    ...(completing === undefined || values === undefined
      ? {}
      : {
          action: {
            type: actedPair(completing).action.type,
            targets: trajectoryTargets(completing, mask),
            values,
          },
        }),
    ...(route === undefined ? {} : { pageRoute: maskedProse(route, mask) }),
  }
}

function projectProcedureTarget(
  handoff: CompletedRunHandoff,
  test: PerTestOutcome,
  mask: MaskFn | undefined,
): CurationCandidateProjection | undefined {
  if (test.outcome !== 'passed') return undefined
  if (test.steps.length < 2) return undefined
  if (!test.steps.every((step) => step.verifierVerdict.pass)) return undefined

  const flowName = test.testId
  const pageAnchors = test.steps.flatMap((step) =>
    exercisedAnchors(actedStep(step)).filter((anchor) => anchor.t === 'page'),
  )
  const platform = actedStateOf(test.steps[0]?.subActions[0])?.platform
  const anchors = uniqueAnchors([
    { t: 'flow', name: flowName },
    ...pageAnchors,
    ...(platform === undefined ? [] : [{ t: 'platform' as const, platform }]),
  ])

  const observations: DistilledObservation[] = test.steps.map((step, position) => {
    const before = actedStateOf(completingSubAction(step))
    const stepPlatform = before?.platform
    const route = before?.url
    const resolved = resolvedElementEvidence(actedStep(step)).at(-1)
    const previous = test.steps[position - 1]
    return {
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
      step: { naturalKey: step.stepText, ordinal: step.stepIndex },
      ...(stepPlatform === undefined
        ? {}
        : { platform: observationPlatform(stepPlatform) }),
      test: { id: test.testId },
      flow: {
        name: flowName,
        ...(previous === undefined ? {} : { precedes: previous.stepText }),
      },
      ...(route === undefined || stepPlatform === undefined
        ? {}
        : {
            surface: {
              kind: stepPlatform === 'web' ? ('page' as const) : ('screen' as const),
              naturalKey: route,
            },
          }),
      ...(resolved === undefined || stepPlatform === undefined
        ? {}
        : { element: { naturalKey: elementNaturalKey(resolved) } }),
      observedAtOrdinal: handoff.buildOrdinal,
    }
  })

  const seed: ProcedureTrajectorySeed = {
    version: PROCEDURE_TRAJECTORY_SEED_VERSION,
    flowName,
    steps: test.steps.map((step) => trajectoryStep(step, mask)),
  }
  const seenArtifacts = new Set<string>()
  const artifactDescriptors = test.steps
    .flatMap(stepArtifactDescriptors)
    .filter((descriptor) => {
      if (seenArtifacts.has(descriptor.ref.id)) return false
      seenArtifacts.add(descriptor.ref.id)
      return true
    })

  return commonFields(
    handoff,
    {
      kind: 'procedure',
      anchors,
      summarySeed: `Procedure ${flowName}: ${test.steps
        .map((step) => maskedProse(step.stepText, mask))
        .join(' -> ')}`,
      bodySeed: canonicalJson(seed),
      observations,
      attributingObservationId: observationId(
        handoff,
        test.testIndex,
        test.steps[0]!.stepIndex,
      ),
      artifactDescriptors,
    },
    mask,
  )
}

// Content addressing is the dedup policy: every verified multi-step pass targets on every drain.
export function projectProcedureTargets(
  handoff: CompletedRunHandoff,
  mask?: MaskFn,
): CurationCandidateProjection[] {
  return handoff.tests.flatMap((test) => {
    const target = projectProcedureTarget(handoff, test, mask)
    return target === undefined ? [] : [target]
  })
}

/** Pure post-verdict projection. Host artifact bytes are resolved only by the emit wrapper. */
export function projectCurationCandidates(
  handoff: CompletedRunHandoff,
  mask?: MaskFn,
): CurationCandidateProjection[] {
  return [
    ...handoff.tests.flatMap((test) => {
      const factsAndMeasurements = test.steps.flatMap((step) => {
        const fact = projectFact(handoff, test, step, mask)
        return [
          ...(fact === undefined ? [] : [fact]),
          ...projectMeasurements(handoff, test, step, mask),
        ]
      })
      const caution = projectCaution(handoff, test, mask)
      return [...factsAndMeasurements, ...(caution === undefined ? [] : [caution])]
    }),
    ...projectProcedureTargets(handoff, mask),
  ]
}

export interface EmitCurationCandidatesOptions {
  handoff: CompletedRunHandoff
  /** Absolute completed-run directory containing runner-local's blobs/ subdirectory. */
  runDir: string
  /** Absolute agent-qa-knowledge root that owns the durable queue. */
  knowledgeRoot: string
  mask?: MaskFn
}

export type EmitCandidateOutcome =
  | EnqueueCurationCandidateProjectionOutcome
  | { kind: 'refused'; reason: 'artifact-io-error' }

export interface EmitCandidateDetail {
  candidateId?: string
  /** The projecting candidate's kind: per-kind outcome attribution from the report alone. */
  kind: CurationCandidateProjection['kind']
  outcome: EmitCandidateOutcome
}

export interface EmitReport {
  enqueued: number
  coalesced: number
  capExceeded: number
  refused: number
  details: EmitCandidateDetail[]
}

function bindArtifactSources(
  projection: CurationCandidateProjection,
  runDir: string,
): CurationProjectionArtifactSource[] {
  return projection.artifactDescriptors.map((descriptor) => ({
    artifactId: descriptor.ref.id,
    sourcePath: join(runDir, RUN_EVIDENCE_BLOBS_SUBDIR, descriptor.ref.sha),
  }))
}

function incrementReport(report: EmitReport, outcome: EmitCandidateOutcome): void {
  if (outcome.kind === 'enqueued') {
    report.enqueued += 1
  } else if (outcome.kind === 'coalesced') {
    report.coalesced += 1
  } else if (outcome.kind === 'cap-exceeded') {
    report.capExceeded += 1
  } else {
    report.refused += 1
  }
}

/**
 * Resolves runner-local artifact blobs and synchronously publishes each candidate in isolation.
 * Queue publication owns temp-write, fsync, cap enforcement, and atomic rename semantics.
 */
export function emitCurationCandidates(opts: EmitCurationCandidatesOptions): EmitReport {
  if (!isAbsolute(opts.runDir)) throw new TypeError('runDir must be absolute')
  if (!isAbsolute(opts.knowledgeRoot)) throw new TypeError('knowledgeRoot must be absolute')

  const report: EmitReport = {
    enqueued: 0,
    coalesced: 0,
    capExceeded: 0,
    refused: 0,
    details: [],
  }
  for (const projected of projectCurationCandidates(opts.handoff, opts.mask)) {
    const artifactSources = bindArtifactSources(projected, opts.runDir)
    let outcome: EmitCandidateOutcome
    try {
      outcome = LOCAL_CURATION_CAPABILITIES.enqueueCurationCandidateProjection({
        knowledgeRoot: opts.knowledgeRoot,
        projection: projected,
        artifactSources,
        ...(opts.mask === undefined ? {} : { mask: opts.mask }),
      })
    } catch (error) {
      if (error instanceof TypeError) throw error
      outcome = { kind: 'refused', reason: 'artifact-io-error' }
    }
    incrementReport(report, outcome)
    report.details.push({
      ...('candidateId' in outcome ? { candidateId: outcome.candidateId } : {}),
      kind: projected.kind,
      outcome,
    })
  }
  return report
}
