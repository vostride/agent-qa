import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import {
  CURATION_SNAPSHOT_SCHEMA_VERSION,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  CurationSnapshotSchema,
  DraftReceiptSchema,
  IMPROVEMENT_PLAN_SCHEMA_VERSION,
  INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  ImprovementPlanSchema,
  JOB_CHECKPOINT_SCHEMA_VERSION,
  KNOWLEDGE_BUNDLE_SUMMARY_SCHEMA_VERSION,
  KnowledgeBundleSummarySchema,
  KnowledgeRecordShowOutputSchema,
  KnowledgeRecordShowResultSchema,
  KnowledgeRecordsDiffOutputSchema,
  KnowledgeRecordsInspectOutputSchema,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  MaskedResolvedConfigSchema,
  RECORD_CHANGE_SCHEMA_VERSION,
  RUN_DETAIL_SCHEMA_VERSION,
  RUN_EVENT_ENVELOPE_SCHEMA_VERSION,
  RUN_START_ACKNOWLEDGEMENT_SCHEMA_VERSION,
  RUN_SUMMARY_SCHEMA_VERSION,
  RunDetailSchema,
  RunEventEnvelopeSchema,
  RunStartAcknowledgementSchema,
  RunSummarySchema,
  guardInspectRecordView,
  guardRecordChange,
  jobCheckpointEnvelopeSchema,
} from '../index'

const scope = { tier: 'suite', key: 'checkout' }

const runSummary = {
  runId: 'run-wire',
  scope,
  buildOrdinal: 4,
  executionContext: 'ci',
  aggregateVerdict: 'passed',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_005_000,
  testCount: 1,
  tests: [{ testIndex: 0, testId: 'checkout-guest', testName: 'Guest checkout' }],
  recordedTargets: { status: 'recorded', names: ['web'] },
}

const runDetail = {
  runId: 'run-wire',
  scope,
  buildOrdinal: 4,
  executionContext: 'ci',
  aggregateVerdict: 'passed',
  configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_005_000,
  tests: [
    {
      testId: 'checkout-guest',
      testName: 'Guest checkout',
      filePath: 'checkout.spec.yaml',
      testIndex: 0,
      outcome: 'passed',
      stepCount: 2,
    },
  ],
}

const runStartAcknowledgement = {
  runId: 'run-wire',
  scope,
  executionContext: 'ci',
  buildOrdinal: 4,
  startedAt: 1_700_000_000_000,
  testCount: 1,
}

const runEventEnvelope = {
  seq: 1,
  ts: 1_700_000_000_000,
  runId: 'run-wire',
  type: 'runStarted',
  payload: {},
}

const knowledgeBundleSummary = {
  bundleId: 'fact-el-cart-button-0123456789abcdef',
  product: 'storefront',
  dir: 'memory/storefront/bundles/fact-el-cart-button-0123456789abcdef',
  kind: 'fact',
  subtype: 'selector',
  scope: { tier: 'product', key: 'storefront' },
  status: 'active',
  trust: 0.82,
  counters: { confirmed: 4, contradicted: 0, helpful: 2, harmful: 0 },
  openedAtOrdinal: 7,
  lastConfirmedOrdinal: 41,
  summary: 'Cart button on checkout',
  evidenceIncomplete: false,
}

const maskedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: 'agent-qa.config.yaml',
  entries: [{ key: 'use.browser.headless', value: 'true', source: 'config-file', masked: false }],
}

const improvementPlan = {
  kind: 'test-edit',
  schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION,
  markId: 'mark_0123456789ab',
  feedbackSource: { runId: 'run-wire', testIndex: 0, kind: 'false-fail' },
  runTraceRef: { runId: 'run-wire', runSlug: 'run-wire' },
  fix: 'test-edit',
  testRef: 'checkout.spec.yaml',
  intent: 'accept the renamed checkout button',
  wording: 'model',
}

const inspectRecordView = {
  schemaVersion: INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  recordId: 'record-1',
  product: 'shop',
  scope: 'product:shop',
  kind: 'fact',
  status: 'active',
  confirmations: 2,
  contradictions: 0,
  evidenceTokens: ['evidence-1'],
  lastEventOrdinal: 42,
  openedAtOrdinal: 10,
  anchors: ['page:/checkout'],
}

const recordChange = {
  schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
  recordId: 'record-1',
  change: 'confirmed',
  atOrdinal: 42,
}

const recordShowOutput = {
  schemaVersion: 2,
  record: inspectRecordView,
  provenance: { schemaVersion: 2, mode: 'standalone', originClass: 'user', sourceDescription: 'authored' },
  summary: 'Cart button on checkout',
  body: 'The cart button reads Add to cart.',
}

const curationSnapshot = {
  schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
  rows: [{ recordId: 'record-1', bucket: 'confirmed', changes: [{ bucket: 'confirmed', change: recordChange }] }],
  breakdown: { added: 0, confirmed: 1, superseded: 0, deprecated: 0, proposed: 0 },
}

const jobCheckpoint = {
  schemaVersion: JOB_CHECKPOINT_SCHEMA_VERSION,
  jobId: 'run-wire->curate-memory',
  checkpointId: 'bundle-committed',
  payload: { committed: 1 },
}

const draftReceipt = {
  schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  draftRef: {
    filePath: 'drafts/checkout.test.yaml',
    testId: 'drafts/checkout.test.yaml::checkout happy path',
    testName: 'checkout happy path',
    contentDigest: 'a'.repeat(64),
  },
  gates: {
    executesDefinitive: { pass: true, runRefs: ['run-1'], indefinitiveRunRefs: [] },
    stableVerdict: { pass: true, runRefs: ['run-1'], distinctOutcomes: ['passed'], earlyStopped: false },
    addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 2 },
    falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
  },
  stepTable: [{
    stepText: 'assert the order number is shown',
    role: 'assertion',
    falsifiable: true,
    captureSignatureHits: [],
  }],
  gateRuns: [{ runId: 'run-1', memberOutcome: 'passed', definitive: true, healed: false }],
  addsValueFinding: {
    novelElements: ['{"anchor":{"name":"order number","ordinal":0,"role":"text","t":"el"}}'],
    comparedTests: [{
      filePath: 'suite/checkout.test.ts',
      testName: 'checkout happy path',
      lane: 'fingerprint',
      covered: false,
    }],
  },
  stabilityRunsRequested: 3,
  stabilityRunsCompleted: 3,
  disposition: 'keep-eligible',
  evaluatedAt: 1_700_000_000_000,
}

// These outputs spell no stamp on the wire; their version is the constant, and a document that
// carries a stamp of its own is refused by the strict schema.
const unstampedOutputs: ReadonlyArray<readonly [string, number, z.ZodType, Record<string, unknown>]> = [
  ['run summary', RUN_SUMMARY_SCHEMA_VERSION, RunSummarySchema, runSummary],
  ['run detail', RUN_DETAIL_SCHEMA_VERSION, RunDetailSchema, runDetail],
  [
    'run start acknowledgement',
    RUN_START_ACKNOWLEDGEMENT_SCHEMA_VERSION,
    RunStartAcknowledgementSchema,
    runStartAcknowledgement,
  ],
  ['run event envelope', RUN_EVENT_ENVELOPE_SCHEMA_VERSION, RunEventEnvelopeSchema, runEventEnvelope],
  ['knowledge bundle summary', KNOWLEDGE_BUNDLE_SUMMARY_SCHEMA_VERSION, KnowledgeBundleSummarySchema, knowledgeBundleSummary],
]

const stampedOutputs: ReadonlyArray<readonly [string, (value: unknown) => unknown, Record<string, unknown>]> = [
  ['masked resolved config', (value) => MaskedResolvedConfigSchema.parse(value), maskedConfig],
  ['improvement plan', (value) => ImprovementPlanSchema.parse(value), improvementPlan],
  ['inspect record view', guardInspectRecordView, inspectRecordView],
  ['record change', guardRecordChange, recordChange],
  [
    'records inspect output',
    (value) => KnowledgeRecordsInspectOutputSchema.parse(value),
    { schemaVersion: 2, records: [inspectRecordView] },
  ],
  [
    'records diff output',
    (value) => KnowledgeRecordsDiffOutputSchema.parse(value),
    { schemaVersion: 2, sinceOrdinal: 40, changes: [recordChange] },
  ],
  ['record show output', (value) => KnowledgeRecordShowOutputSchema.parse(value), recordShowOutput],
  [
    'record show result, found',
    (value) => KnowledgeRecordShowResultSchema.parse(value),
    { kind: 'found', ...recordShowOutput },
  ],
  [
    'record show result, not found',
    (value) => KnowledgeRecordShowResultSchema.parse(value),
    { kind: 'not-found', schemaVersion: 2, recordId: 'record-9' },
  ],
  ['curation snapshot', (value) => CurationSnapshotSchema.parse(value), curationSnapshot],
  ['job checkpoint', (value) => jobCheckpointEnvelopeSchema.parse(value), jobCheckpoint],
  ['draft receipt', (value) => DraftReceiptSchema.parse(value), draftReceipt],
]

describe('wire stamps', () => {
  it.each(unstampedOutputs)('the %s version is 2', (_name, version) => {
    expect(version).toBe(2)
  })

  it.each(unstampedOutputs)('a %s parses as its builder produces it', (_name, _version, schema, document) => {
    expect(schema.safeParse(document).success).toBe(true)
  })

  it.each(unstampedOutputs)('a %s stamped 1 is refused', (_name, _version, schema, document) => {
    const result = schema.safeParse({ ...document, schemaVersion: 1 })
    expect(result.success).toBe(false)
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['schemaVersion'] }),
    )
  })

  it.each(stampedOutputs)('a %s reads at 2', (_name, read, document) => {
    expect(document.schemaVersion).toBe(2)
    expect(read(document)).toEqual(document)
  })

  it.each(stampedOutputs)('a %s stamped 1 is refused', (_name, read, document) => {
    expect(() => read({ ...document, schemaVersion: 1 })).toThrow()
  })
})
