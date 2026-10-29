import { describe, expect, test } from 'vitest'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardCompletedRunHandoff,
  projectStepFinalized,
  RETRIEVAL_RUNG_REASONS,
  RETRIEVAL_RUNGS,
  RecordedRetrievalRungSchema,
  RunKnowledgeProjectionSchema,
  asRunId,
} from '../index'
import type { StepEvidence } from '../index'

// Independent vocabularies, spelled by hand so neither list is derived from production.
const SHARED_REASONS = [
  'native-runtime-unavailable',
  'profile-unresolved',
  'model-not-downloaded',
  'embedder-load-failed',
  'index-unavailable',
  'floor-disabled',
  'profile-static-configured',
] as const
const NEW_INDEX_REASONS = ['index-not-built', 'index-locked', 'index-corrupt'] as const
const CURRENT_REASONS = [...SHARED_REASONS, ...NEW_INDEX_REASONS] as const

const identity = (value: string) => value

function stepWith(retrievalRung?: unknown): StepEvidence {
  return {
    stepIndex: 0,
    stepText: 'open the synthetic page',
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'suite', key: 'synthetic' },
      asOfBuild: 1,
      budget: 100,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'digest-synthetic',
    },
    subActions: [],
    verifierVerdict: { pass: true, reasoning: 'synthetic' },
    ...(retrievalRung === undefined ? {} : { retrievalRung }),
  } as StepEvidence
}

function handoffWith(retrievalRung: unknown): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-rung-contract'),
    scope: { tier: 'suite', key: 'synthetic' },
    buildOrdinal: 1,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1,
    endedAt: 2,
    tests: [{
      testId: 't-1',
      testName: 'synthetic',
      filePath: 'tests/synthetic.test.yaml',
      testIndex: 0,
      outcome: 'passed',
      steps: [stepWith(retrievalRung)],
    }],
  }
}

/** Every persisted reader sees the same bytes: the schema, the handoff guard and stepFinalized. */
function readThroughEveryReader(recorded: Record<string, unknown>) {
  const parsed = RecordedRetrievalRungSchema.parse(recorded)
  const guarded = guardCompletedRunHandoff(handoffWith(recorded))
  const finalized = projectStepFinalized(
    stepWith(recorded),
    { testIndex: 0, stepIndex: 0 },
    identity,
  )
  return {
    parsed,
    handoff: guarded.tests[0]?.steps[0]?.retrievalRung,
    stepFinalized: finalized.retrievalRung,
  }
}

describe('retrieval rung reasons', () => {
  test('pins ten current reasons, in order, against an independent list', () => {
    expect(RETRIEVAL_RUNG_REASONS).toEqual([...CURRENT_REASONS])
    expect(new Set(RETRIEVAL_RUNG_REASONS).size).toBe(10)
    expect(RETRIEVAL_RUNGS).toEqual(['memidex', 'bundle-scan', 'static-floor', 'lexical-only'])
  })

  test('the recorded rung admits exactly the ten reasons and no invented word', () => {
    const admitted = CURRENT_REASONS.filter((reason) => RecordedRetrievalRungSchema.safeParse({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason,
    }).success)
    expect(admitted).toEqual([...CURRENT_REASONS])
    expect(RecordedRetrievalRungSchema.safeParse({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason: 'index-missing',
    }).success).toBe(false)
  })

  test.each([1, 3])('a recorded rung stamped %i is refused', (schemaVersion) => {
    const recorded = { schemaVersion, rung: 'bundle-scan', reason: 'index-unavailable' }
    expect(RecordedRetrievalRungSchema.safeParse(recorded).success).toBe(false)
    expect(() => guardCompletedRunHandoff(handoffWith(recorded))).toThrow(
      /failed structural validation/,
    )
  })
})

describe('RUNG-V2', () => {
  test.each([
    { schemaVersion: 2, rung: 'memidex' },
    { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-not-built' },
    { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-locked' },
    { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt' },
    { schemaVersion: 2, rung: 'lexical-only', reason: 'model-not-downloaded' },
  ])('current bytes stay readable and byte-identical through every reader: %j', (recorded) => {
    const read = readThroughEveryReader(recorded)
    const bytes = JSON.stringify(recorded)
    expect(JSON.stringify(read.parsed)).toBe(bytes)
    expect(JSON.stringify(read.handoff)).toBe(bytes)
    expect(JSON.stringify(read.stepFinalized)).toBe(bytes)
  })

  test('the three new causes remain distinct values after a read', () => {
    const reasons = NEW_INDEX_REASONS.map((reason) => readThroughEveryReader({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason,
    }).handoff?.reason)
    expect(reasons).toEqual(['index-not-built', 'index-locked', 'index-corrupt'])
  })
})

describe('LEGACY-HISTORICAL', () => {
  test('the legacy code stays a member of the current vocabulary with its historical meaning', () => {
    expect(RETRIEVAL_RUNG_REASONS).toContain('index-unavailable')
    expect(RecordedRetrievalRungSchema.parse({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason: 'index-unavailable',
    })).toEqual({ schemaVersion: 2, rung: 'bundle-scan', reason: 'index-unavailable' })
  })
})

describe('RUNG-INVALID-VERSION', () => {
  const INVALID: readonly unknown[] = [
    ...NEW_INDEX_REASONS.map((reason) => ({ schemaVersion: 1, rung: 'bundle-scan', reason })),
    { schemaVersion: 3, rung: 'bundle-scan', reason: 'index-corrupt' },
    { schemaVersion: 0, rung: 'bundle-scan', reason: 'index-unavailable' },
    { schemaVersion: '2', rung: 'bundle-scan', reason: 'index-corrupt' },
    { rung: 'bundle-scan', reason: 'index-corrupt' },
    { schemaVersion: 2, rung: 'dense-only' },
    { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt', detail: 'synthetic' },
    { schemaVersion: 1, rung: 'bundle-scan', reason: 'index-unavailable', upgradedTo: 2 },
  ]

  test.each(INVALID)('the schema refuses a mislabelled, future or widened value: %j', (invalid) => {
    expect(RecordedRetrievalRungSchema.safeParse(invalid).success).toBe(false)
  })

  test.each(INVALID)('the persisted handoff guard refuses the same step: %j', (invalid) => {
    expect(() => guardCompletedRunHandoff(handoffWith(invalid))).toThrow(
      /failed structural validation/,
    )
  })

  test.each(INVALID)('the runs.knowledge wire contract refuses it at run level: %j', (invalid) => {
    const projection = {
      kind: 'ready',
      runId: 'run-rung-contract',
      buildOrdinal: 1,
      knowledgeStore: 'bound',
      steps: [],
      curation: { status: 'pending' },
      learned: { changes: [], canaryAttributions: [] },
    }
    expect(RunKnowledgeProjectionSchema.safeParse(projection).success).toBe(true)
    expect(RunKnowledgeProjectionSchema.safeParse({ ...projection, retrievalRung: invalid }).success)
      .toBe(false)
    expect(RunKnowledgeProjectionSchema.safeParse({
      ...projection,
      retrievalRung: { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt' },
    }).success).toBe(true)
  })
})
