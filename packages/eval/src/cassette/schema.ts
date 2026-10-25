import {
  MemoryOnPathEntrySchema,
  RecordedRetrievalRungSchema,
  workingMemoryEntrySchema,
} from '@vostride/agent-qa-schema'
import { z } from 'zod'
import { actionWireSchema } from './action-wire-schema'
import { CASSETTE_SCHEMA_VERSION } from './cassette'

const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const digestSchema = z
  .string()
  .regex(LOWER_HEX_64, 'must be a 64-character lowercase hexadecimal digest')

const pointSchema = z.object({ x: z.number(), y: z.number() }).passthrough()
const boundingBoxSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
  .passthrough()
const viewportSchema = z.object({ width: z.number(), height: z.number() }).passthrough()

const scopeSchema = z
  .object({ tier: z.enum(['global', 'product', 'suite', 'test']), key: z.string() })
  .passthrough()

const anchorSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('page'), route: z.string() }).passthrough(),
  z.object({ t: z.literal('flow'), name: z.string() }).passthrough(),
  z
    .object({
      t: z.literal('el'),
      role: z.string(),
      name: z.string(),
      ordinal: z.number().optional(),
    })
    .passthrough(),
  z.object({ t: z.literal('platform'), platform: z.enum(['web', 'android', 'ios']) }).passthrough(),
  z.object({ t: z.literal('selector'), literal: z.string() }).passthrough(),
  z.object({ t: z.literal('error'), message: z.string() }).passthrough(),
])

const elementStateSchema = z
  .object({
    enabled: z.boolean(),
    focused: z.boolean(),
    visible: z.boolean(),
    selected: z.boolean().optional(),
    checked: z.boolean().optional(),
    editable: z.boolean().optional(),
    clickable: z.boolean().optional(),
  })
  .passthrough()

const elementLabelsSchema = z
  .object({
    testId: z.string().optional(),
    ariaLabel: z.string().optional(),
    placeholder: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough()

const elementHierarchySchema = z
  .object({
    parentRef: z.string().optional(),
    childRefs: z.array(z.string()).optional(),
  })
  .passthrough()

const elementInfoSchema = z
  .object({
    ref: z.string(),
    role: z.string(),
    name: z.string(),
    nameNormalized: z.string(),
    value: z.string().optional(),
    bounds: boundingBoxSchema.optional(),
    center: pointSchema.optional(),
    state: elementStateSchema,
    labels: elementLabelsSchema,
    hierarchy: elementHierarchySchema.optional(),
    attributes: z.record(z.string(), z.string()),
  })
  .passthrough()

const scrollContextSchema = z
  .object({
    container: z.string().optional(),
    offsetX: z.number(),
    offsetY: z.number(),
  })
  .passthrough()

const elementBoundsSchema = z
  .object({
    bounds: boundingBoxSchema,
    center: pointSchema,
    scrollContext: scrollContextSchema.optional(),
  })
  .passthrough()

const screenScrollSchema = z
  .object({
    offsetX: z.number(),
    offsetY: z.number(),
    contentWidth: z.number(),
    contentHeight: z.number(),
  })
  .passthrough()

const metadataBaseShape = {
  coordSpace: z.enum(['viewport', 'content', 'screen']),
  viewportWidth: z.number(),
  viewportHeight: z.number(),
  scroll: screenScrollSchema,
  domContext: z.string().optional(),
}

const screenMetadataSchema = z.discriminatedUnion('captureMode', [
  z
    .object({
      ...metadataBaseShape,
      captureMode: z.literal('full'),
      imageWidth: z.number(),
      imageHeight: z.number(),
    })
    .passthrough(),
  z.object({ ...metadataBaseShape, captureMode: z.literal('textOnly') }).passthrough(),
])

const screenStateSchema = z
  .object({
    platform: z.enum(['web', 'android', 'ios']),
    tree: z.string(),
    elements: z.array(elementInfoSchema),
    refMap: z.record(z.string(), elementBoundsSchema),
    url: z.string().optional(),
    timestamp: z.number(),
    metadata: screenMetadataSchema,
  })
  .passthrough()

const briefLineSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    summary: z.string(),
    trust: z.number(),
    status: z.string(),
    servedAsCanary: z.boolean(),
    tier: z.string(),
  })
  .passthrough()

const readTraceSchema = z
  .object({ id: z.string(), detailLevel: z.string(), bodyDigest: z.string() })
  .passthrough()

const cautionLineSchema = z
  .object({ id: z.string(), anchors: z.array(anchorSchema), summary: z.string() })
  .passthrough()

const servedBriefSchema = z
  .object({
    scope: scopeSchema,
    asOfBuild: z.number(),
    budget: z.number(),
    truncation: z.string(),
    channel1: z.array(briefLineSchema),
    channel2: z.array(readTraceSchema),
    channel3: z.array(cautionLineSchema),
    briefDigest: z.string(),
  })
  .passthrough()

const samplingParamsSchema = z
  .object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    stop: z.array(z.string()).optional(),
    seed: z.number().optional(),
  })
  .passthrough()

const modelIdentitySchema = z
  .object({ provider: z.string(), modelId: z.string() })
  .passthrough()

const declaredModelProfileSchema = z
  .object({
    provider: z.string(),
    modelId: z.string(),
    vision: z.boolean(),
    maxOutputTokens: z.number().optional(),
    sampling: samplingParamsSchema.optional(),
  })
  .passthrough()

const toolExchangeSchema = z
  .object({
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    result: z.unknown(),
  })
  .passthrough()
  .superRefine((exchange, context) => {
    if (!Object.prototype.hasOwnProperty.call(exchange, 'result')) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'is required',
      })
    }
  })

const annotationBaseShape = {
  viewport: viewportSchema,
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  failureHighlight: boundingBoxSchema.optional(),
}

const actionAnnotationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...annotationBaseShape,
      kind: z.literal('point'),
      point: z
        .object({ x: z.number(), y: z.number(), boundingBox: boundingBoxSchema.optional() })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...annotationBaseShape,
      kind: z.literal('path'),
      path: z.object({ start: pointSchema, end: pointSchema }).passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...annotationBaseShape,
      kind: z.literal('pinch'),
      pinch: z.object({ center: pointSchema, scale: z.number() }).passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...annotationBaseShape,
      kind: z.literal('region'),
      region: z.object({ boundingBox: boundingBoxSchema }).passthrough(),
    })
    .passthrough(),
])

const verifierVerdictSchema = z
  .object({ pass: z.boolean(), reasoning: z.string() })
  .passthrough()

const artifactRefSchema = z
  .object({
    id: z.string().min(1),
    sha: digestSchema,
    evidenceIncomplete: z.boolean().optional(),
  })
  .passthrough()

const verdictEvidenceSchema = z
  .object({
    citedSteps: z.array(z.number()),
    citedAnchors: z.array(anchorSchema),
    citedArtifacts: z.array(artifactRefSchema),
    rationale: z.string(),
  })
  .passthrough()

const verdictAttributionSchema = z
  .object({ records: z.array(z.string()), anchors: z.array(anchorSchema) })
  .passthrough()

const verdictBaseShape = {
  // D-03 lockstep with schema verdict.ts: the minting-pipeline discriminator,
  // closed to exactly two literals (D-06 mirror discipline).
  producer: z.enum(['deterministic-classifier', 'analyze-run']),
  confidence: z.number(),
  evidence: verdictEvidenceSchema,
  attribution: verdictAttributionSchema.optional(),
  memoryMisdirectionRuledOut: z.boolean(),
  // Validated, not passed through: the verdict object is `.passthrough()`.
  memoryOnPath: z.array(MemoryOnPathEntrySchema).optional(),
  perTest: z.number(),
}

const verdictSchema = z.discriminatedUnion('class', [
  z
    .object({
      ...verdictBaseShape,
      class: z.literal('test_bug'),
      subtype: z
        .enum(['stale_selector', 'outdated_flow', 'bad_assertion', 'wrong_expected_value'])
        .optional(),
    })
    .passthrough(),
  z.object({ ...verdictBaseShape, class: z.literal('app_bug') }).passthrough(),
  z.object({ ...verdictBaseShape, class: z.literal('environment') }).passthrough(),
  z.object({ ...verdictBaseShape, class: z.literal('flake') }).passthrough(),
  z.object({ ...verdictBaseShape, class: z.literal('config_error') }).passthrough(),
  z.object({ ...verdictBaseShape, class: z.literal('llm_error') }).passthrough(),
  z.object({ ...verdictBaseShape, class: z.literal('unknown') }).passthrough(),
  z.object({ ...verdictBaseShape, class: z.literal('timeout') }).passthrough(),
])

const assertValueSchema = z
  .object({
    source: z.string(),
    op: z.enum(['isNull', 'isDefined', 'equals', 'notEquals', 'gt', 'lt', 'contains']),
    expected: z.string().optional(),
    actual: z.union([z.string(), z.null()]).optional(),
    passed: z.boolean(),
  })
  .passthrough()

const inputLegSchema = z
  .object({
    testId: z.string(),
    testIndex: z.number(),
    stepIndex: z.number(),
    decisionOrdinal: z.number(),
    stepText: z.string(),
    stateBefore: screenStateSchema,
    servedBrief: servedBriefSchema,
    workingMemory: z.array(workingMemoryEntrySchema).optional(),
    retrievalRung: RecordedRetrievalRungSchema.optional(),
    exchanges: z.array(toolExchangeSchema),
    modelProfile: declaredModelProfileSchema.optional(),
    decisionScreenshotRef: artifactRefSchema.optional(),
    auxiliaryArtifactRefs: z.array(artifactRefSchema).optional(),
  })
  .strict()

const goldAnchorSchema = z
  .object({
    role: z.string(),
    nameNormalized: z.string(),
    ordinal: z.number(),
    ref: z.string().optional(),
  })
  .strict()

const sidecarLegSchema = z
  .object({
    goldAction: actionWireSchema,
    opClass: z.string(),
    goldValue: z.string().optional(),
    goldAnchor: goldAnchorSchema.optional(),
    equivalenceSet: z.array(goldAnchorSchema),
    annotation: actionAnnotationSchema.optional(),
  })
  .strict()

const contrastivePairingSchema = z
  .object({
    pairedCassetteId: z.string(),
    relation: z.enum(['contrastive-positive', 'contrastive-negative']),
  })
  .strict()

const recordedFailureSchema = z
  .object({
    verifierReasoning: z.string().optional(),
    planningFailureReason: z.string().optional(),
    termination: z.string().optional(),
  })
  .strict()

const labelLegSchema = z
  .object({
    verdict: verifierVerdictSchema.optional(),
    sourceChannel: z.enum([
      'recorded-verdict',
      'user-mark',
      'overturned-verdict',
      'self-heal-pair',
    ]),
    tier: z.enum(['gold', 'near-gold', 'silver']),
    recordedFailure: recordedFailureSchema.optional(),
    rootCause: verdictSchema.optional(),
    pairing: contrastivePairingSchema.optional(),
  })
  .strict()

const modelReceiptSchema = z
  .object({
    declared: modelIdentitySchema.optional(),
    resolvedModelId: z.string().optional(),
    fingerprint: z.string().optional(),
  })
  .strict()

const samplingReceiptSchema = z
  .object({
    declared: samplingParamsSchema.optional(),
    effective: samplingParamsSchema.optional(),
  })
  .strict()

const judgeReceiptSchema = z
  .object({
    recordedVerifier: modelIdentitySchema.optional(),
    tier4JudgeId: z.string().optional(),
  })
  .strict()

const receiptSchema = z
  .object({
    promptInputHash: digestSchema,
    model: modelReceiptSchema,
    sampling: samplingReceiptSchema,
    toolSchemaDigest: digestSchema.optional(),
    screenStateHash: digestSchema,
    memoryBriefDigest: digestSchema.optional(),
    judge: judgeReceiptSchema,
    buildOrdinal: z.number(),
  })
  .strict()

const missingEvidenceSchema = z
  .object({
    kind: z.literal('decision-screenshot-ref'),
    stepIndex: z.number().int().nonnegative(),
    decisionOrdinal: z.number().int().nonnegative(),
  })
  .strict()

const completenessSchema = z
  .object({
    status: z.enum(['complete', 'evidence-incomplete', 'anchor-unresolved']),
    missingBlobShas: z.array(digestSchema).optional(),
    unresolvedAnchorRef: z.string().optional(),
    missingEvidence: z.array(missingEvidenceSchema).nonempty().optional(),
  })
  .strict()

const decisionRecordSchema = z
  .object({
    input: inputLegSchema,
    sidecar: sidecarLegSchema,
    label: labelLegSchema,
    receipt: receiptSchema,
  })
  .strict()

const procedureStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('decision'),
      stepIndex: z.number(),
      decisionOrdinal: z.number(),
      record: decisionRecordSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cache-served'),
      stepIndex: z.number(),
      decisionOrdinal: z.number(),
    })
    .strict(),
  z.object({ kind: z.literal('synthesized'), stepIndex: z.number() }).strict(),
])

const procedureEndStateSchema = z
  .object({
    outcome: z.enum(['passed', 'failed', 'healed', 'timeout', 'cancelled', 'skipped']),
    finalVerdict: verifierVerdictSchema.optional(),
    finalAssert: assertValueSchema.optional(),
  })
  .strict()

const envelopeShape = {
  schemaVersion: z.literal(CASSETTE_SCHEMA_VERSION),
  id: z.string(),
  runId: z.string(),
  testId: z.string(),
  testIndex: z.number(),
  blobs: z.array(digestSchema),
  completeness: completenessSchema,
}

const leafCassetteSchema = z
  .object({
    ...envelopeShape,
    granularity: z.literal('leaf'),
    stepIndex: z.number(),
    decisionOrdinal: z.number(),
    input: inputLegSchema,
    sidecar: sidecarLegSchema,
    label: labelLegSchema,
    receipt: receiptSchema,
  })
  .strict()

const procedureCassetteSchema = z
  .object({
    ...envelopeShape,
    granularity: z.literal('procedure'),
    steps: z.array(procedureStepSchema),
    endState: procedureEndStateSchema,
  })
  .strict()

/** The wire validator for both cassette granularities. */
export const cassetteSchema = z.discriminatedUnion('granularity', [
  leafCassetteSchema,
  procedureCassetteSchema,
])
