// Driven through the real registry, so input, handoff gate, op and output contract are one path.

import { createHash } from 'node:crypto'

import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CurationSnapshotSchema,
  EvidenceEntrySchema,
  KnowledgeRecordShowResultSchema,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  RunOverviewProjectionSchema,
  asRunId,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  EvidenceDocument,
  EvidenceEntry,
  FunctionCaller,
  MaskFn,
  PerTestOutcome,
  RecordChange,
  RecordedTargets,
  RunDetailRows,
  RunDetailStep,
  RunDetailSubAction,
  RunOverviewProjection,
  RunsArtifactResult,
  RunsEvidenceResult,
  ServedBrief,
  StepEvidence,
} from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'

import { FunctionInputError, FunctionNotBoundError, invokeFunction } from '../invoke.js'
import { EvidenceBlobAbsentError } from '../ops/runs-artifact.js'
import { RunNotFoundError } from '../ops/runs-get.js'
import { createFunctionRegistry } from '../registry.js'
import type {
  EvidenceBlobReaderPort,
  FunctionDeps,
  KnowledgeReaderPort,
  PostProcessingChainState,
  StepEvidenceLookup,
} from '../spec.js'

const OVERVIEW = 'runs.overview'
const RUN_ID = 'run-overview'

const READER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

const sha = (seed: string) => createHash('sha256').update(seed).digest('hex')

function handoffStep(stepIndex: number, stepText: string): StepEvidence {
  return {
    stepIndex,
    stepText,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: 'shop' },
      asOfBuild: 5,
      budget: 400,
      truncation: '',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: `brief-${String(stepIndex)}`,
    },
    subActions: [],
    verifierVerdict: { pass: true, reasoning: 'recorded reasoning' },
  }
}

function member(testIndex: number, testId: string, testName: string, steps: StepEvidence[]): PerTestOutcome {
  return { testId, testName, filePath: `tests/${testId}.yaml`, testIndex, outcome: 'passed', steps }
}

function completed(tests: PerTestOutcome[]): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(RUN_ID),
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 5,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_000,
    endedAt: 9_000,
    tests,
  }
}

function detailStep(testIndex: number, stepIndex: number, stepText: string): RunDetailStep {
  return {
    testIndex,
    stepIndex,
    stepText,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'recorded reasoning' },
    selfHealOccurred: false,
    briefDigest: `brief-${String(stepIndex)}`,
    status: 'passed',
    durationMs: 227.4,
    tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  }
}

function subAction(testIndex: number, stepIndex: number, subActionIndex: number): RunDetailSubAction {
  const screenshot = sha(`shot-${String(testIndex)}-${String(stepIndex)}-${String(subActionIndex)}`)
  return {
    testIndex,
    stepIndex,
    subActionIndex,
    plan: 'recorded plan prose',
    plannedAction: { type: 'navigate', to: 'url', url: 'https://example.test' },
    result: { success: true },
    screenStateHash: 'before',
    artifactRefs: [{ id: `decision-screenshot:${screenshot}`, sha: screenshot }],
  }
}

const EMPTY_KNOWLEDGE: KnowledgeReaderPort = {
  listBundles: () => Promise.resolve([]),
  inspectRecords: () => Promise.resolve([]),
  diffSince: () => Promise.resolve([]),
  showRecord: ({ recordId }) => Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId }),
}

interface Scene {
  document: CompletedRunHandoff | undefined
  rows: RunDetailRows | undefined
  targets?: RecordedTargets
  bindDetail?: boolean
  secretMask?: MaskFn | null
}

function singleTestScene(): Scene {
  return {
    document: completed([member(0, 'test-checkout', 'Checkout smoke', [
      handoffStep(0, 'Open the home page'),
      handoffStep(1, 'Click Pay'),
    ])]),
    rows: {
      runId: RUN_ID,
      members: [{ testIndex: 0, testId: 'test-checkout', name: 'Checkout smoke', attempts: 1,
        outcome: 'passed', failureSummary: 'dashboard-only text' }],
      steps: [detailStep(0, 0, 'Open the home page'), detailStep(0, 1, 'Click Pay')],
      subActions: [subAction(0, 0, 0), subAction(0, 1, 0)],
    },
    targets: { status: 'recorded', names: ['example-web'] },
  }
}

function harness(scene: Scene) {
  const detailRead = vi.fn(async () => scene.rows)
  const deps: FunctionDeps = {
    runs: {
      list: () => Promise.resolve(scene.document === undefined ? [] : [scene.document]),
      get: (runId) => Promise.resolve(scene.document?.runId === runId ? scene.document : undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
      ...(scene.targets === undefined
        ? {}
        : { getRecordedTargets: () => Promise.resolve(scene.targets as RecordedTargets) }),
    },
    knowledge: EMPTY_KNOWLEDGE,
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    ...(scene.bindDetail === false ? {} : { runDetail: { read: detailRead } }),
    ...(scene.secretMask === null ? {} : { secretMask: scene.secretMask ?? identity }),
  }
  const registry = createFunctionRegistry({ deps })
  return {
    registry,
    detailRead,
    overview: (input: unknown) => invokeFunction(registry, OVERVIEW, input, READER),
  }
}

const identity: MaskFn = text => text
function declaredMask(secrets: Record<string, string>): MaskFn {
  const redactor = new SecretRedactor(new SecretStore(secrets))
  return text => redactor.redactString(text)
}

describe('OVERVIEW-REGISTRY: runs.overview is a registered read over one completed run', () => {
  it('lists runs.overview as a bound read-only registry op', () => {
    const declaration = harness(singleTestScene()).registry.list(READER)
      .find((entry) => entry.id === OVERVIEW)
    expect(declaration).toMatchObject({
      id: OVERVIEW,
      resultKind: 'unary',
      bindingStatus: 'bound',
      risk: { name: `fn:${OVERVIEW}`, recognized: true, readOnly: true },
    })
  })

  it('lists runs.overview unbound where the host owns no run-detail reader', async () => {
    const h = harness({ ...singleTestScene(), bindDetail: false })
    expect(h.registry.list(READER).find((entry) => entry.id === OVERVIEW)?.bindingStatus)
      .toBe('unbound')
    await expect(h.overview({ runId: RUN_ID })).rejects.toBeInstanceOf(FunctionNotBoundError)
  })

  it('returns the compact run, test and step identity of a completed single-test run', async () => {
    const result = await harness(singleTestScene()).overview({ runId: RUN_ID })
    expect(result).toMatchObject({
      runId: RUN_ID,
      scope: { tier: 'product', key: 'shop' },
      recordedTargets: { status: 'recorded', names: ['example-web'] },
      aggregateVerdict: 'passed',
      buildOrdinal: 5,
      startedAt: 1_000,
      endedAt: 9_000,
      tests: [{
        testIndex: 0,
        testId: 'test-checkout',
        name: { text: 'Checkout smoke' },
        outcome: 'passed',
        steps: [
          { stepIndex: 0, label: { text: 'Open the home page' }, status: 'passed' },
          { stepIndex: 1, label: { text: 'Click Pay' }, status: 'passed' },
        ],
      }],
    })
  })

  it('reports unknown recorded targets when the reader cannot say', async () => {
    const scene = singleTestScene()
    delete scene.targets
    expect(await harness(scene).overview({ runId: RUN_ID }))
      .toMatchObject({ recordedTargets: { status: 'unknown' } })
  })

  it('carries no dashboard tree, token sum, plan prose or member failure text', async () => {
    const result = await harness(singleTestScene()).overview({ runId: RUN_ID }) as Record<string, unknown>
    for (const key of ['members', 'subActions', 'tokens', 'models', 'steps']) {
      expect(result).not.toHaveProperty(key)
    }
    const wire = JSON.stringify(result)
    for (const fragment of ['plannedAction', 'recorded plan prose', 'dashboard-only text',
      'tokenUsage', 'recorded reasoning', 'screenStateHash']) {
      expect(wire).not.toContain(fragment)
    }
  })

  it('refuses a run with no completed handoff before reading any projection rows', async () => {
    const missing = harness({ document: undefined, rows: undefined })
    await expect(missing.overview({ runId: RUN_ID })).rejects.toBeInstanceOf(RunNotFoundError)

    const inProgress = harness({ ...singleTestScene(), document: undefined })
    await expect(inProgress.overview({ runId: RUN_ID })).rejects.toBeInstanceOf(RunNotFoundError)
    expect(inProgress.detailRead).not.toHaveBeenCalled()
  })

  it('refuses extra input keys and an unsafe run id at the strict input contract', async () => {
    const h = harness(singleTestScene())
    await expect(h.overview({ runId: RUN_ID, testIndex: 0 })).rejects.toBeInstanceOf(FunctionInputError)
    await expect(h.overview({ runId: '../outside' })).rejects.toBeInstanceOf(FunctionInputError)
    await expect(h.overview({})).rejects.toBeInstanceOf(FunctionInputError)
    expect(h.detailRead).not.toHaveBeenCalled()
  })
})

// Every recorded detail, addressed exactly.

const encode = (text: string) => new TextEncoder().encode(text)
const bytesOf = (value: unknown) => encode(JSON.stringify(value))
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const LONG_NAME = '🔎'.repeat(170)
const LONG_SUMMARY = `the cart badge counts items ${'é'.repeat(200)}`

interface Multi {
  document: CompletedRunHandoff
  rows: RunDetailRows
  blobs: Map<string, Uint8Array>
  documents: Map<string, EvidenceDocument>
  screenshots: Map<string, string>
}

function briefWith(channels: Partial<Pick<ServedBrief, 'channel1' | 'channel2' | 'channel3'>>): ServedBrief {
  return { ...handoffStep(0, '').servedBrief, ...channels }
}

function multiScene(): Multi {
  const blobs = new Map<string, Uint8Array>()
  const documents = new Map<string, EvidenceDocument>()
  const screenshots = new Map<string, string>()
  const store = (document: EvidenceDocument, prefix: string, stored = true) => {
    const bytes = bytesOf(document)
    const digest = hashOf(bytes)
    if (stored) blobs.set(digest, bytes)
    documents.set(digest, document)
    return { id: `${prefix}:${digest}`, sha: digest }
  }
  const shot = (tag: string, stored = true) => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...encode(tag)])
    const digest = hashOf(bytes)
    if (stored) blobs.set(digest, bytes)
    screenshots.set(tag, digest)
    return { id: `decision-screenshot:${digest}`, sha: digest }
  }
  const entry = (value: unknown) => EvidenceEntrySchema.parse(value) as EvidenceEntry

  const consoleT0 = store({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console',
    records: [{ level: 'error', text: 'console body t0s0', timestamp: 1 }] }, 'console-evidence')
  const networkT0 = store({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [{ url: 'https://example.test/t0s0',
    method: 'GET', status: 500, requestHeaders: {}, responseHeaders: {}, startTime: 1, endTime: 2,
    body: 'network body t0s0' }] }, 'network-evidence')
  const ariaT0A0 = store({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: 'aria tree t0s0a0' }, 'aria-state')
  const consoleT1 = store({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console',
    records: [{ level: 'warning', text: 'console body t1s0', timestamp: 1 }] }, 'console-evidence', false)
  const a11yT1 = store({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'a11y', records: [{ ruleId: 'label', impact: 'serious',
    description: 'a11y body t1s0', help: 'label it', helpUrl: 'https://example.test/rule',
    nodes: [{ html: '<input>', target: ['#q'] }] }] }, 'a11y-evidence')
  const shotT0A0 = shot('t0s0a0')
  const shotT0A1 = shot('t0s0a1')
  const shotT0S1 = shot('t0s1a0', false)
  const recordingBytes = encode('webm recording t0')
  const recordingSha = hashOf(recordingBytes)
  blobs.set(recordingSha, recordingBytes)

  const t0s0: RunDetailStep = {
    ...detailStep(0, 0, 'Open the home page'),
    evidence: {
      console: entry({ kind: 'console', state: 'present', ref: consoleT0,
        counts: { total: 1, errors: 1, warnings: 0 } }) as NonNullable<RunDetailStep['evidence']>['console'],
      network: entry({ kind: 'network', state: 'present', ref: networkT0,
        counts: { total: 12, failed: 1, errored: 0 } }) as NonNullable<RunDetailStep['evidence']>['network'],
      a11y: { kind: 'a11y', state: 'absent', reason: 'empty' },
      variables: { kind: 'variables', state: 'present', counts: { count: 1 } },
    },
    variableSnapshot: { token: { value: 'variable value t0s0', source: 'capture' } },
  }
  const t0s1: RunDetailStep = { ...detailStep(0, 1, 'Click Pay'), status: 'failed' }
  const t1s0: RunDetailStep = {
    ...detailStep(1, 0, 'Search for shirt'),
    evidence: {
      console: entry({ kind: 'console', state: 'present', ref: consoleT1,
        counts: { total: 3, errors: 0, warnings: 3 } }) as NonNullable<RunDetailStep['evidence']>['console'],
      network: { kind: 'network', state: 'absent', reason: 'not-captured' },
      a11y: entry({ kind: 'a11y', state: 'present', ref: a11yT1,
        counts: { minor: 1, moderate: 0, serious: 2, critical: 0 } }) as NonNullable<RunDetailStep['evidence']>['a11y'],
      variables: { kind: 'variables', state: 'absent', reason: 'unsupported' },
    },
  }
  const child = (testIndex: number, stepIndex: number, subActionIndex: number,
    extra: Partial<RunDetailSubAction>): RunDetailSubAction => {
    const base = subAction(testIndex, stepIndex, subActionIndex)
    delete base.artifactRefs
    return { ...base, ...extra }
  }

  const document = completed([
    member(0, 'test-checkout', 'Checkout smoke', [
      { ...handoffStep(0, 'Open the home page'),
        retrievalTrace: { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
          servedLines: [{ recordId: 'rec-a', leg: 'anchor', rank: 1, score: 0.5 }],
          truncated: [{ recordId: 'rec-cut', leg: 'lexical', rank: 9, score: 0.1 }] },
        servedBrief: briefWith({
          channel1: [{ id: 'rec-a' as never, kind: 'fact', summary: LONG_SUMMARY, trust: 0.8,
            status: 'active', servedAsCanary: false, tier: 'context' }],
          channel2: [{ id: 'rec-b' as never, detailLevel: 'summary', bodyDigest: 'body-digest-b' }],
          channel3: [{ id: 'rec-c' as never, anchors: [], summary: 'the pay button moves on mobile' }],
        }) },
      handoffStep(1, 'Click Pay'),
    ]),
    { ...member(1, 'test-search', LONG_NAME, [{ ...handoffStep(0, 'Search for shirt'),
      servedBrief: briefWith({ channel2: [{ id: 'rec-missing' as never, detailLevel: 'full',
        bodyDigest: 'body-digest-missing' }] }) }]), outcome: 'failed' },
  ])
  const rows: RunDetailRows = {
    runId: RUN_ID,
    members: [
      { testIndex: 0, testId: 'test-checkout', attempts: 1, recording: { state: 'present',
        ref: { id: `recording:${recordingSha}`, sha: recordingSha }, contentType: 'video/webm',
        byteLength: recordingBytes.length, durationMs: 1200 } },
      { testIndex: 1, testId: 'test-search', attempts: 1,
        recording: { state: 'absent', reason: 'not-captured' } },
    ],
    steps: [t1s0, t0s1, t0s0],
    subActions: [
      child(0, 0, 1, { artifactRefs: [shotT0A1],
        ariaEvidence: { kind: 'aria', state: 'absent', reason: 'failed' } }),
      child(0, 0, 0, { artifactRefs: [shotT0A0, ariaT0A0],
        ariaEvidence: entry({ kind: 'aria', state: 'present', ref: ariaT0A0 }) as RunDetailSubAction['ariaEvidence'] }),
      child(0, 1, 0, { artifactRefs: [shotT0S1] }),
      child(1, 0, 0, {}),
    ],
  }
  return { document, rows, blobs, documents, screenshots }
}

function currentRecord(recordId: string) {
  return KnowledgeRecordShowResultSchema.parse({
    kind: 'found', schemaVersion: 2, summary: `current summary of ${recordId}`,
    body: `Current body of ${recordId}`,
    provenance: { schemaVersion: 1, mode: 'standalone', originClass: 'agent-observed',
      sourceDescription: 'synthetic inspection' },
    record: { schemaVersion: INSPECT_RECORD_VIEW_SCHEMA_VERSION, recordId, product: 'shop', scope: 'checkout', kind: 'procedure',
      status: 'active', confirmations: 2, contradictions: 0, evidenceTokens: ['evidence-current'],
      openedAtOrdinal: 1, lastEventOrdinal: 5, anchors: ['page:/checkout'] },
  })
}

function learnedChange(overrides: Partial<RecordChange>): RecordChange {
  return { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'rec-learned', change: 'added', atOrdinal: 5, ...overrides }
}

function snapshot() {
  const classified = (recordId: string, change: RecordChange['change']) => learnedChange({
    recordId, change, sourceRunId: RUN_ID, evidenceToken: `receipt-${recordId}`,
    observationId: `observation-${recordId}` })
  return CurationSnapshotSchema.parse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [
    { recordId: 'rec-learned', bucket: 'added', changes: [{ bucket: 'added', change: classified('rec-learned', 'added') }] },
    { recordId: 'rec-a', bucket: 'confirmed', changes: [{ bucket: 'confirmed', change: classified('rec-a', 'confirmed') }] },
  ], breakdown: { added: 1, confirmed: 1, superseded: 0, deprecated: 0, proposed: 0 } })
}

const FOUND = new Set(['rec-a', 'rec-b', 'rec-c', 'rec-learned'])

interface MultiOptions {
  rows?: RunDetailRows | undefined
  blobs?: Partial<EvidenceBlobReaderPort> & { withoutHas?: boolean }
  knowledge?: Partial<KnowledgeReaderPort>
  chain?: PostProcessingChainState | undefined
  bindPostProcessing?: boolean
  secretMask?: MaskFn | null
}

function multiHarness(scene: Multi, options: MultiOptions = {}) {
  const has = vi.fn(async (_runId: string, digest: string) =>
    scene.blobs.has(digest) ? 'found' as const : 'blob_absent' as const)
  const evidenceBlobs: EvidenceBlobReaderPort = {
    read: async (_runId, digest) => {
      const bytes = scene.blobs.get(digest)
      return bytes === undefined ? { status: 'blob_absent' } : { status: 'found', bytes }
    },
    ...(options.blobs?.withoutHas === true ? {} : { has }),
  }
  const readStepEvidence = async (
    _runId: string,
    address: { stepIndex: number; testId?: string },
  ): Promise<StepEvidenceLookup> => {
    const candidates = scene.document.tests.filter((test) =>
      address.testId === undefined || test.testId === address.testId)
    const matches = candidates.flatMap((test) =>
      test.steps.filter((step) => step.stepIndex === address.stepIndex).map((step) => ({ test, step })))
    if (matches.length > 1) return { kind: 'ambiguous-step-address', testIds: matches.map((m) => m.test.testId) }
    return matches[0] === undefined ? { kind: 'step-not-found' } : { kind: 'found', evidence: matches[0].step }
  }
  const show = (recordId: string) => FOUND.has(recordId)
    ? currentRecord(recordId)
    : { kind: 'not-found' as const, schemaVersion: 2 as const, recordId }
  const rows = 'rows' in options ? options.rows : scene.rows
  const deps: FunctionDeps = {
    runs: {
      list: () => Promise.resolve([scene.document]),
      get: (runId) => Promise.resolve(runId === scene.document.runId ? scene.document : undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: readStepEvidence as FunctionDeps['runs']['readStepEvidence'],
      getRecordedTargets: () => Promise.resolve({ status: 'recorded', names: ['example-web'] }),
    },
    knowledge: {
      ...EMPTY_KNOWLEDGE,
      showRecord: ({ recordId }) => Promise.resolve(show(recordId)),
      showRecords: ({ recordIds }) => Promise.resolve(recordIds.map(show)),
      diffSince: () => Promise.resolve([learnedChange({ sourceRunId: RUN_ID })]),
      ...options.knowledge,
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    runDetail: { read: async () => rows },
    evidenceBlobs,
    ...(options.secretMask === null ? {} : { secretMask: options.secretMask ?? identity }),
    ...(options.bindPostProcessing === false ? {} : {
      postProcessing: {
        idSource: { jobIdFor: (kind: string, key: string) => `${kind}:${key}` as never },
        readChain: () => Promise.resolve('chain' in options ? options.chain
          : { curationSnapshot: snapshot(), curateMemory: { status: 'done', claimed: false } }),
      },
    }),
  }
  const registry = createFunctionRegistry({ deps })
  const call = (id: string, input: unknown) => invokeFunction(registry, id, input, READER)
  return {
    has,
    call,
    overview: async () => RunOverviewProjectionSchema.parse(await call(OVERVIEW, { runId: RUN_ID })),
  }
}

type OverviewStep = RunOverviewProjection['tests'][number]['steps'][number]
const stepOf = (overview: RunOverviewProjection, testIndex: number, stepIndex: number): OverviewStep => {
  const found = overview.tests.find((test) => test.testIndex === testIndex)?.steps
    .find((step) => step.stepIndex === stepIndex)
  if (found === undefined) throw new Error(`no step ${String(testIndex)}:${String(stepIndex)}`)
  return found
}
const captureOf = (step: OverviewStep) => {
  if (step.capture.state !== 'recorded') throw new Error('capture unavailable')
  return step.capture
}
const knowledgeOf = (step: OverviewStep) => {
  if (step.knowledge.state !== 'recorded') throw new Error('knowledge unavailable')
  return step.knowledge
}
const decode = (result: RunsArtifactResult) => Uint8Array.from(atob(result.bytesBase64), (c) => c.charCodeAt(0))

describe('OVERVIEW-ADDRESS-ROUNDTRIP: every returned address fetches exactly its own detail', () => {
  it('orders every test and step by recorded index across a multi-test run', async () => {
    const overview = await multiHarness(multiScene()).overview()
    expect(overview.tests.map((test) => [test.testIndex, test.testId, test.outcome]))
      .toEqual([[0, 'test-checkout', 'passed'], [1, 'test-search', 'failed']])
    expect(overview.tests.map((test) => test.steps.map((step) => step.stepIndex))).toEqual([[0, 1], [0]])
    expect(stepOf(overview, 0, 1).status).toBe('failed')
  })

  it('round-trips screenshots, five evidence kinds, ARIA sub-actions, records, briefs and recordings', async () => {
    const scene = multiScene()
    const h = multiHarness(scene)
    const overview = await h.overview()
    const visited = { screenshots: 0, evidence: 0, aria: 0, records: 0, briefs: 0, recordings: 0 }
    for (const test of overview.tests) {
      expect(test, `test ${String(test.testIndex)}`).toHaveProperty('recording.state')
      for (const step of test.steps) {
        expect(step, `step ${String(step.stepIndex)}`).toHaveProperty('capture.state', 'recorded')
        expect(step, `step ${String(step.stepIndex)}`).toHaveProperty('knowledge.state', 'recorded')
      }
    }

    for (const test of overview.tests) {
      if (test.recording.state === 'present') {
        const blob = await h.call('runs.artifact', test.recording.address) as RunsArtifactResult
        expect(blob.sha).toBe(test.recording.address.sha)
        expect(blob.byteLength).toBe(test.recording.byteLength)
        visited.recordings += 1
      }
      for (const step of test.steps) {
        const tag = `t${String(test.testIndex)}s${String(step.stepIndex)}`
        const capture = captureOf(step)
        for (const shot of capture.screenshots) {
          expect(shot.address).toEqual({ runId: RUN_ID, sha: shot.sha })
          expect(scene.screenshots.get(`${tag}a${String(shot.subActionIndex)}`)).toBe(shot.sha)
          if (shot.present === false) {
            await expect(h.call('runs.artifact', shot.address)).rejects.toBeInstanceOf(EvidenceBlobAbsentError)
          } else {
            expect(decode(await h.call('runs.artifact', shot.address) as RunsArtifactResult))
              .toEqual(scene.blobs.get(shot.sha))
          }
          visited.screenshots += 1
        }
        const entries = [...Object.values(capture.evidence), ...capture.aria]
        for (const entry of entries) {
          const read = await h.call('runs.evidence', entry.address) as RunsEvidenceResult
          expect(read.address).toEqual(entry.address)
          expect(entry.address).toMatchObject({ runId: RUN_ID, testIndex: test.testIndex, stepIndex: step.stepIndex })
          if (entry.state === 'absent') {
            expect(read).toMatchObject({ outcome: 'absent', evidence: { state: 'absent', reason: entry.reason } })
          } else if ('present' in entry && entry.present === false) {
            expect(read).toMatchObject({ outcome: 'absent', evidence: { evidenceIncomplete: true } })
          } else {
            expect(read.outcome).toBe('ready')
            const body = JSON.stringify(read.outcome === 'ready' ? read.document : null)
            if (read.address.kind !== 'variables') {
              const suffix = read.address.kind === 'aria' ? `a${String(read.address.subActionIndex)}` : ''
              expect(body).toContain(`${tag}${suffix}`)
            }
          }
          if (entry.address.kind === 'aria') visited.aria += 1
          else visited.evidence += 1
        }
        const knowledge = knowledgeOf(step)
        for (const record of knowledge.records) {
          const shown = await h.call('knowledge.record.show', { recordId: record.recordId }) as { kind: string }
          expect(shown.kind).toBe(record.unavailable?.reason === 'not-found' ? 'not-found' : 'found')
          visited.records += 1
        }
        expect(knowledge.brief.address).toEqual({ runId: RUN_ID, testId: test.testId, stepIndex: step.stepIndex })
        const why = await h.call('knowledge.brief.why', knowledge.brief.address) as { kind: string; reason?: string }
        expect(why.kind).toBe(knowledge.brief.trace.kind)
        if (knowledge.brief.trace.kind === 'no-trace') expect(why.reason).toBe(knowledge.brief.trace.reason)
        visited.briefs += 1
      }
    }
    expect(visited).toEqual({ screenshots: 3, evidence: 12, aria: 4, records: 4, briefs: 3, recordings: 1 })
  })

  it('preserves stored counts and never invents an ARIA node count', async () => {
    const overview = await multiHarness(multiScene()).overview()
    const first = captureOf(stepOf(overview, 0, 0))
    expect(first.evidence.console).toMatchObject({ state: 'present', counts: { total: 1, errors: 1, warnings: 0 } })
    expect(first.evidence.network).toMatchObject({ state: 'present', counts: { total: 12, failed: 1, errored: 0 } })
    expect(first.evidence.variables).toMatchObject({ state: 'present', counts: { count: 1 } })
    expect(captureOf(stepOf(overview, 1, 0)).evidence.a11y)
      .toMatchObject({ state: 'present', counts: { minor: 1, moderate: 0, serious: 2, critical: 0 } })
    for (const aria of first.aria) expect(aria).not.toHaveProperty('counts')
  })

  it('carries no body, trace ledger, evidence document, variable value or byte payload', async () => {
    const wire = JSON.stringify(await multiHarness(multiScene()).overview())
    for (const fragment of ['Current body', 'console body', 'network body', 'a11y body', 'aria tree',
      'variable value', 'rec-cut', 'bodyDigest', 'body-digest', 'webm recording', 'iVBOR', 'bytesBase64',
      'servedLines', 'recorded reasoning', 'plannedAction']) {
      expect(wire, fragment).not.toContain(fragment)
    }
  })
})

describe('OVERVIEW-ABSENCES: missing, unknown, withheld and incomplete stay distinct', () => {
  it('keeps capture-time absence reasons, missing blobs and historical gaps apart', async () => {
    const overview = await multiHarness(multiScene()).overview()
    const first = captureOf(stepOf(overview, 0, 0))
    expect(first.evidence.a11y).toMatchObject({ state: 'absent', reason: 'empty' })
    expect(first.aria.map((aria) => [aria.subActionIndex, aria.state])).toEqual([[0, 'present'], [1, 'absent']])
    expect(first.aria[1]).toMatchObject({ state: 'absent', reason: 'failed' })
    expect(first.screenshots.map((shot) => [shot.subActionIndex, shot.present])).toEqual([[0, true], [1, true]])

    const historical = captureOf(stepOf(overview, 0, 1))
    for (const kind of ['console', 'network', 'a11y', 'variables'] as const) {
      expect(historical.evidence[kind]).toMatchObject({ kind, state: 'absent', reason: 'unavailable' })
    }
    expect(historical.aria).toEqual([expect.objectContaining({ subActionIndex: 0, state: 'absent', reason: 'unavailable' })])
    expect(historical.screenshots).toEqual([expect.objectContaining({ subActionIndex: 0, present: false })])

    const second = captureOf(stepOf(overview, 1, 0))
    expect(second.evidence.console).toMatchObject({ state: 'present', present: false })
    expect(second.evidence.network).toMatchObject({ state: 'absent', reason: 'not-captured' })
    expect(second.evidence.variables).toMatchObject({ state: 'absent', reason: 'unsupported' })
    expect(second.screenshots).toEqual([])

    expect(overview.tests[0]?.recording).toMatchObject({ state: 'present', contentType: 'video/webm', present: true })
    expect(overview.tests[1]?.recording).toEqual({ state: 'absent', reason: 'not-captured' })
  })

  it('leaves presence unknown, never false, when the host cannot stat its blobs', async () => {
    const overview = await multiHarness(multiScene(), { blobs: { withoutHas: true } }).overview()
    const first = captureOf(stepOf(overview, 0, 0))
    for (const shot of first.screenshots) expect(shot).not.toHaveProperty('present')
    expect(first.evidence.console).not.toHaveProperty('present')
    expect(first.aria[0]).not.toHaveProperty('present')
    expect(overview.tests[0]?.recording).not.toHaveProperty('present')
  })

  it('stats each distinct blob once for the whole overview', async () => {
    const h = multiHarness(multiScene())
    await h.overview()
    const asked = h.has.mock.calls.map(([, digest]) => digest)
    expect(new Set(asked).size).toBe(asked.length)
    expect(asked.length).toBe(9)
  })

  it('marks capture unavailable when the host holds no projection rows for a completed run', async () => {
    const overview = await multiHarness(multiScene(), { rows: undefined }).overview()
    for (const test of overview.tests) {
      expect(test.recording).toEqual({ state: 'absent', reason: 'unavailable' })
      for (const step of test.steps) {
        expect(step.capture).toEqual({ state: 'unavailable' })
        expect(step.knowledge.state).toBe('recorded')
      }
    }
  })

  it('names a record whose kind or summary is unavailable instead of inferring it', async () => {
    const overview = await multiHarness(multiScene()).overview()
    const used = knowledgeOf(stepOf(overview, 0, 0)).records
    expect(used.map((record) => [record.recordId, record.channel])).toEqual([
      ['rec-a', 'brief'], ['rec-b', 'read'], ['rec-c', 'caution']])
    expect(used[0]).toMatchObject({ kind: 'fact' })
    expect(used[1]).toMatchObject({ kind: 'procedure', summary: { text: 'current summary of rec-b' } })
    expect(used[2]).toMatchObject({ kind: 'procedure', summary: { text: 'the pay button moves on mobile' } })
    for (const record of used) expect(record).not.toHaveProperty('unavailable')
    expect(knowledgeOf(stepOf(overview, 1, 0)).records).toEqual([
      { recordId: 'rec-missing', channel: 'read', unavailable: { reason: 'not-found' } }])
    expect(knowledgeOf(stepOf(overview, 0, 0)).brief.trace).toEqual({ kind: 'answered' })
    expect(knowledgeOf(stepOf(overview, 0, 1)).brief.trace).toEqual({ kind: 'no-trace', reason: 'pre-trace-run' })
  })

  it('reports a scan that could not finish on every record and on the learned half', async () => {
    const overview = await multiHarness(multiScene(), { knowledge: { showRecords: async () => {
      throw Object.assign(new Error('synthetic private path'), { name: 'KnowledgeMaintenanceScanError' })
    } } }).overview()
    const used = knowledgeOf(stepOf(overview, 0, 0)).records
    expect(used[0]).toMatchObject({ recordId: 'rec-a', kind: 'fact' })
    expect(used[1]).toEqual({ recordId: 'rec-b', channel: 'read', unavailable: { reason: 'scan-incomplete' } })
    expect(used[2]).toMatchObject({ recordId: 'rec-c', unavailable: { reason: 'scan-incomplete' } })
    expect(overview.learned.scanIncomplete).toBe(true)
    expect(JSON.stringify(overview)).not.toContain('synthetic private path')
  })
})

describe('OVERVIEW-LEARNED: what the run learned, with every record id and bucket count', () => {
  it('carries the recorded snapshot rows, its breakdown and the attributed changes', async () => {
    const overview = await multiHarness(multiScene()).overview()
    expect(overview.learned).toMatchObject({
      knowledgeStore: 'bound',
      snapshot: {
        state: 'recorded',
        breakdown: { added: 1, confirmed: 1, superseded: 0, deprecated: 0, proposed: 0 },
        rows: [{ recordId: 'rec-learned', bucket: 'added' }, { recordId: 'rec-a', bucket: 'confirmed' }],
      },
    })
    expect(overview.learned.changes).toEqual([{ recordId: 'rec-learned', change: 'added', atOrdinal: 5 }])
    expect(overview.learned).not.toHaveProperty('scanIncomplete')
  })

  it('distinguishes a snapshot never recorded from one withheld', async () => {
    const none = await multiHarness(multiScene(), { bindPostProcessing: false }).overview()
    expect(none.learned.snapshot).toEqual({ state: 'not-recorded' })
    const collapsing: MaskFn = text => text === 'rec-a' ? 'rec-learned' : text
    const withheld = await multiHarness(multiScene(), { secretMask: collapsing }).overview()
    expect(withheld.learned.snapshot).toEqual({ state: 'withheld', reason: 'projection-refused' })
    expect(withheld.tests[0]?.name).toEqual({ text: 'Checkout smoke' })
    await expect(multiHarness(multiScene(), { secretMask: null }).overview())
      .rejects.toThrow(/no declared-secret mask/)
    await expect(multiHarness(multiScene(), { secretMask: () => { throw new Error('synthetic unreadable secrets file') } })
      .overview()).rejects.toThrow('synthetic unreadable secrets file')
  })
})

describe('OVERVIEW-TRUNCATION: only labels and one-line summaries are cut', () => {
  it('cuts at 160 code points with a visible indicator and keeps every id', async () => {
    const overview = await multiHarness(multiScene()).overview()
    const name = overview.tests[1]!.name
    expect(name.truncated).toBe(true)
    expect([...name.text]).toHaveLength(161)
    expect(name.text).toBe(`${'🔎'.repeat(160)}…`)
    expect(overview.tests[1]?.testId).toBe('test-search')
    const summary = knowledgeOf(stepOf(overview, 0, 0)).records[0]!.summary!
    expect(summary).toEqual({ text: `${[...LONG_SUMMARY].slice(0, 160).join('')}…`, truncated: true })
    expect(overview.tests[0]?.name).toEqual({ text: 'Checkout smoke' })
  })

  it('masks a declared multi-line secret before collapsing its line breaks', async () => {
    const secret = '-----BEGIN KEY-----\nT-pem-sentinel\n-----END KEY-----'
    const scene = singleTestScene()
    scene.secretMask = declaredMask({ PEM_KEY: secret })
    scene.document = completed([member(0, 'test-checkout', `Sign with\n${secret}`, [
      handoffStep(0, `Paste ${secret} into the form`),
    ])])
    const result = JSON.stringify(await harness(scene).overview({ runId: RUN_ID }))
    expect(result).not.toContain('T-pem-sentinel')
    expect(result).toContain(JSON.stringify('Sign with [secret:PEM_KEY]').slice(1, -1))
  })
})
