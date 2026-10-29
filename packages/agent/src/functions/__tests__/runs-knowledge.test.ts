// `runs.knowledge` — the Knowledge panel's one read (Phase 407 plan 01, LERN-01 / LERN-02).
//
// WHAT THESE CELLS ARE SHAPED TO CATCH. This op is a PROJECTION over a run's handoff plus three
// sibling-op compositions, and the failure mode of a projection test is a green suite that only
// ever compared shapes. So every fixture below carries values the op would be WRONG to pass
// through unchanged — a step whose trace is absent beside one whose trace is present, a
// notification row carrying exactly one of its two counts, a record change belonging to a
// NEIGHBOURING run — because a projection fed already-correct data cannot be distinguished from
// a coincidence.
//
// The three claims the phase rests on and that a shape comparison would not see:
//   1. A pruned handoff is a RESULT (`evidence-incomplete`), never a throw (D-06).
//   2. "No knowledge reader was bound" is derived from the DURABLE truncation marker, not from a
//      handoff version (D-16).
//   3. A learned change is kept only when it is ATTRIBUTABLE to this run (D-10) — attribution
//      unknown means the row is dropped, never guessed at.

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  NO_KNOWLEDGE_READER_TRUNCATION,
  RunKnowledgeProjectionSchema,
  asRunId,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  PerTestOutcome,
  RecordChange,
  RecordedRetrievalRung,
  RunNotification,
  ScopeKey,
  ServedBrief,
  StepEvidence,
  StepPlanSource,
} from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { CurationSnapshotSchema, KnowledgeRecordShowResultSchema } from '@vostride/agent-qa-schema'
import type { MaskFn } from '@vostride/agent-qa-schema'
import { createFunctionRegistry } from '../registry.js'
import { invokeFunction } from '../invoke.js'

import { knowledgeRecordsDiffSpec } from '../ops/knowledge-records-diff.js'
import { runsDigestSpec } from '../ops/runs-digest.js'
import { runsPostProcessingSpec } from '../ops/runs-post-processing.js'
import { runsKnowledgeSpec } from '../ops/runs-knowledge.js'
import type {
  FunctionDeps,
  KnowledgeReaderPort,
  PostProcessingChainState,
} from '../spec.js'

const RUN_ID = 'RUN-407-01'
const OTHER_RUN_ID = 'RUN-407-99'
const SCOPE: ScopeKey = { tier: 'product', key: 'shop' }

const RUNG: RecordedRetrievalRung = {
  schemaVersion: 2,
  rung: 'static-floor',
  reason: 'native-runtime-unavailable',
}

/**
 * A served brief with whatever channels the cell cares about.
 *
 * `truncation` defaults to the ORDINARY empty string rather than to the D-16 marker, so a cell
 * that wants the unbound-store derivation has to ask for it by name — the marker is the whole
 * signal and a fixture that carried it by default would make cell (d) unfalsifiable.
 */
function brief(overrides: Partial<ServedBrief> = {}): ServedBrief {
  return {
    scope: SCOPE,
    asOfBuild: 12,
    budget: 400,
    truncation: '',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: 'digest-0',
    ...overrides,
  }
}

function step(stepIndex: number, overrides: Partial<StepEvidence> = {}): StepEvidence {
  return {
    stepIndex,
    stepText: `step ${String(stepIndex)}`,
    cacheStatus: 'miss',
    servedBrief: brief(),
    subActions: [],
    verifierVerdict: { pass: true, reasoning: 'ok' },
    ...overrides,
  }
}

function test(
  testIndex: number,
  steps: StepEvidence[],
  testId = `t_${String(testIndex)}`,
): PerTestOutcome {
  return {
    testId,
    testName: `test ${String(testIndex)}`,
    filePath: `tests/${testId}.yaml`,
    testIndex,
    outcome: 'passed',
    steps,
  }
}

function handoff(tests: PerTestOutcome[], overrides: Partial<CompletedRunHandoff> = {}) {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(RUN_ID),
    scope: SCOPE,
    buildOrdinal: 12,
    executionContext: 'local',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-a', testConfigDigest: 'test-a' },
    startedAt: 1,
    endedAt: 2,
    tests,
    ...overrides,
  } as CompletedRunHandoff
}

const REPLAY: StepPlanSource = {
  kind: 'procedure-replay',
  procedureId: 'rec-proc-1' as StepPlanSource extends { procedureId: infer P } ? P : never,
  guard: {
    checksPassed: 2,
    total: 3,
    miss: { procedureStepIndex: 2, reason: 'page-anchor-mismatch' },
  },
  // 407-12 (CR-01). `recordProcedureReplaySource` writes `flow` on EVERY replay it records, so a
  // fixture without it could not see the seam at all: the arm was `.strict()` and never declared
  // the member, and the wire refused every real replay run while this file stayed green.
  flow: { cursor: 0, length: 3 },
}

const HINT: StepPlanSource = {
  kind: 'procedure-hint',
  procedureId: 'rec-proc-2' as StepPlanSource extends { procedureId: infer P } ? P : never,
  demotion: 'body-empty',
}

/**
 * The default handoff every cell that does not need a special one reads: TWO member tests of TWO
 * steps each, deliberately asymmetric. Test 0 step 0 carries a trace and a replay; test 0 step 1
 * carries neither; test 1 step 0 serves a canary line; test 1 step 1 carries a hint. A symmetric
 * fixture would let a projection that dropped `testIndex` or reversed the flat-map still pass.
 */
function twoByTwo(): CompletedRunHandoff {
  return handoff([
    test(0, [
      step(0, {
        planSource: REPLAY,
        retrievalTrace: {
          schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
          servedLines: [{ recordId: 'rec-a', leg: 'anchor', rank: 1, score: 0.5 }],
          truncated: [{ recordId: 'rec-cut', leg: 'lexical', rank: 9, score: 0.1 }],
        },
        servedBrief: brief({
          channel1: [{
            id: 'rec-a' as never,
            kind: 'fact',
            summary: 'the cart badge counts items',
            trust: 0.8,
            status: 'active',
            servedAsCanary: false,
            tier: 'context',
          }],
          channel2: [{ id: 'rec-b' as never, detailLevel: 'summary', bodyDigest: 'body-1' }],
          channel3: [{
            id: 'rec-c' as never,
            anchors: [],
            summary: 'the checkout button moves on mobile',
          }],
        }),
      }),
      step(1),
    ]),
    test(1, [
      step(0, {
        servedBrief: brief({
          channel1: [{
            id: 'rec-canary' as never,
            kind: 'fact',
            summary: 'a canary line',
            trust: 0.4,
            status: 'active',
            servedAsCanary: true,
            tier: 'context',
          }],
        }),
      }),
      step(1, { planSource: HINT }),
    ]),
  ])
}

const EMPTY_KNOWLEDGE: KnowledgeReaderPort = {
  listBundles: () => Promise.resolve([]),
  inspectRecords: () => Promise.resolve([]),
  diffSince: () => Promise.resolve([]),
  showRecord: ({ recordId }) => Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId }),
}

interface DepsOptions {
  document?: CompletedRunHandoff | undefined
  knowledge?: Partial<KnowledgeReaderPort>
  chain?: PostProcessingChainState | undefined
  bindPostProcessing?: boolean
  bindProposalsInbox?: boolean
  secretMask?: MaskFn | null
}

function declaredMask(secrets: Record<string, string>): MaskFn {
  const redactor = new SecretRedactor(new SecretStore(secrets))
  return text => redactor.redactString(text)
}

function deps(options: DepsOptions = {}): FunctionDeps {
  const document = 'document' in options ? options.document : twoByTwo()
  const base: FunctionDeps = {
    runs: {
      list: () => Promise.resolve(document === undefined ? [] : [document]),
      get: () => Promise.resolve(document),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: { ...EMPTY_KNOWLEDGE, ...options.knowledge },
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
  }
  return {
    ...base,
    ...(options.secretMask === null ? {} : { secretMask: options.secretMask ?? ((text: string) => text) }),
    ...(options.bindPostProcessing === true
      ? {
          postProcessing: {
            idSource: { jobIdFor: (kind, key) => `${kind}:${key}` as never },
            readChain: () => Promise.resolve(options.chain),
          },
        }
      : {}),
    ...(options.bindProposalsInbox === true
      ? {
          // 2026-10-02 (432-42, D-05/D-22): no inbox port is handed in. The dep key was deleted by
          // 432-17 and nothing can read it; C432-LEFTOVERS-UNREAD pins that no source names it.
        }
      : {}),
  }
}

function change(overrides: Partial<RecordChange> = {}): RecordChange {
  return {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
    recordId: 'rec-1',
    change: 'confirmed',
    atOrdinal: 12,
    ...overrides,
  }
}

function currentRecord(recordId: string) {
  return KnowledgeRecordShowResultSchema.parse({
    kind: 'found', schemaVersion: 2, summary: `購入 é e\u0301 ${recordId}`,
    body: `Current body 🧪 ${recordId}`,
    provenance: { schemaVersion: 1, mode: 'standalone', originClass: 'agent-observed', sourceDescription: 'synthetic inspection' },
    record: { schemaVersion: INSPECT_RECORD_VIEW_SCHEMA_VERSION, recordId, product: 'shop', scope: 'checkout', kind: 'fact',
      status: 'superseded', confirmations: 7, contradictions: 2, evidenceTokens: ['evidence-current'],
      openedAtOrdinal: 8, closedAtOrdinal: 90, lastEventOrdinal: 90,
      anchors: ['page:/checkout', 'el:購入'], trustNarrative: 'Current supporting evidence' },
  })
}

function fixedSnapshot() {
  const classified = (recordId: string, kind: RecordChange['change'], atOrdinal: number) =>
    change({ recordId, change: kind, atOrdinal, sourceRunId: RUN_ID,
      evidenceToken: `receipt-${recordId}`, observationId: `observation-${recordId}` })
  return CurationSnapshotSchema.parse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [
      { recordId: 'added', bucket: 'added', changes: [{ bucket: 'added', change: classified('added', 'added', 20) }] },
      { recordId: 'confirmed', bucket: 'confirmed', changes: [
        { bucket: 'confirmed', change: classified('confirmed', 'confirmed', 21) },
        { bucket: 'confirmed', change: { ...classified('confirmed', 'confirmed', 21), evidenceToken: 'second-confirm', observationId: 'second-observation' } },
      ] },
      { recordId: 'victim', bucket: 'superseded', byRecordId: 'replacement', changes: [
        { bucket: 'superseded', change: { ...classified('victim', 'superseded', 22), byRecordId: 'replacement' } },
        { bucket: 'added', change: classified('replacement', 'added', 22) },
      ] },
      { recordId: 'deprecated', bucket: 'deprecated', changes: [{ bucket: 'deprecated', change: classified('deprecated', 'deprecated', 23) }] },
      { recordId: 'proposed', bucket: 'proposed', changes: [{ bucket: 'proposed', change: classified('proposed', 'added', 24) }] },
    ], breakdown: { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 } })
}

/**
 * The fixed snapshot's changes as a REAL store's diffSince reports them (427-02 Task 1,
 * SNAPSHOT-ROWS-IN-DIFF): an Add carries the run link and no receipt token, while a confirmation,
 * deprecation or supersession of a record an earlier run created carries its token and no run.
 * Nothing here stamps sourceRunId on an unlinked change. Returned in the store's own identity order,
 * which is the order runs.knowledge serves.
 */
function realShapedDiff(snapshot: ReturnType<typeof fixedSnapshot>): RecordChange[] {
  return snapshot.rows.flatMap(row => row.changes.map(({ change: recorded }) => {
    if (recorded.change === 'added') {
      return change({ recordId: recorded.recordId, change: 'added', atOrdinal: recorded.atOrdinal, sourceRunId: RUN_ID })
    }
    const unlinked: RecordChange = { ...recorded }
    delete unlinked.sourceRunId
    return unlinked
  })).sort((left, right) => (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0)
    || left.atOrdinal - right.atOrdinal)
}

const identityOf = (row: RecordChange) =>
  [row.recordId, row.change, row.atOrdinal, row.byRecordId ?? '', row.evidenceToken ?? ''].join('|')

describe('current content and fixed historical sections', () => {

  it('USED-ALL-CHANNELS: one union batch enriches learned and every used channel', async () => {
    const showRecords = vi.fn(async ({ recordIds }: { recordIds: readonly string[] }) => recordIds.map(currentRecord))
    const unary = vi.fn(async () => { throw new Error('per-ID fallback forbidden') })
    const result = await ready({ knowledge: { showRecords, showRecord: unary,
      diffSince: async () => [change({ recordId: 'rec-a', sourceRunId: RUN_ID }), change({ recordId: 'learned-only', sourceRunId: RUN_ID })] } })
    expect(showRecords).toHaveBeenCalledTimes(1)
    expect(new Set(showRecords.mock.calls[0]?.[0].recordIds)).toEqual(new Set(['rec-a', 'rec-b', 'rec-c', 'rec-canary', 'learned-only']))
    expect(showRecords.mock.calls[0]?.[0].recordIds).toHaveLength(5)
    expect(unary).not.toHaveBeenCalled()
    for (const row of [...result.steps.flatMap(s => [...s.served.channel1, ...s.served.channel2, ...s.served.channel3]), ...result.learned.changes]) {
      expect(row).toHaveProperty('recordContent', expect.objectContaining({ kind: 'fact', currentStatus: 'superseded',
        applicability: { product: 'shop', scope: 'checkout', anchors: ['page:/checkout', 'el:購入'],
          openedAtOrdinal: 8, closedAtOrdinal: 90 },
        currentTrust: { confirmations: 7, contradictions: 2, evidenceTokens: ['evidence-current'],
          lastEventOrdinal: 90, trustNarrative: 'Current supporting evidence' } }))
    }
    expect(RunKnowledgeProjectionSchema.parse(result)).toEqual(result)
  })

  it('CURRENT-VS-HISTORICAL: joined present-day facts cannot rewrite served trust or change identity', async () => {
    const historical = change({ recordId: 'rec-a', sourceRunId: RUN_ID, observationId: 'old-observation', evidenceToken: 'old-token' })
    const result = await ready({ knowledge: { diffSince: async () => [historical],
      showRecords: async ({ recordIds }) => recordIds.map(currentRecord) } })
    expect(result.learned.changes[0]).toMatchObject(historical)
    expect(result.learned.changes[0]).toHaveProperty('recordContent.currentStatus', 'superseded')
    expect(result.steps[0]?.served.channel1[0]).toMatchObject({ trust: 0.8, status: 'active',
      recordContent: { content: 'Current body 🧪 rec-a', summary: '購入 é e\u0301 rec-a', currentTrust: { confirmations: 7 } } })
  })

  it('NOT-FOUND-RETAINED: missing exact Unicode identities remain learned and used rows', async () => {
    const ids = ['é', 'e\u0301', '__proto__']
    const showRecords = vi.fn(async ({ recordIds }: { recordIds: readonly string[] }) => recordIds.map(recordId => ({ kind: 'not-found' as const, schemaVersion: 2 as const, recordId })))
    const result = await ready({ knowledge: { showRecords,
      diffSince: async () => ids.map(recordId => change({ recordId, sourceRunId: RUN_ID })) } })
    expect(result.learned.changes.map(row => row.recordId)).toEqual(['__proto__', 'e\u0301', 'é'])
    for (const row of [...result.learned.changes, ...result.steps[0]!.served.channel2]) {
      expect(row).toHaveProperty('contentAbsence', { reason: 'not-found' })
      expect(row).not.toHaveProperty('recordContent')
    }
    expect(result.learned).not.toHaveProperty('scanIncomplete')
  })

  it('SCAN-INCOMPLETE: failed batch retains both halves and differs from an ordinary missing record', async () => {
    const result = await ready({ knowledge: { diffSince: async () => [change({ sourceRunId: RUN_ID })],
      showRecords: async () => { throw Object.assign(new Error('synthetic private path'), { name: 'KnowledgeMaintenanceScanError' }) } } })
    expect(result.learned.changes).toHaveLength(1)
    expect(result.steps).toHaveLength(4)
    expect(result.learned).toHaveProperty('scanIncomplete', true)
    expect(result.learned.changes[0]).toHaveProperty('contentAbsence', { reason: 'scan-incomplete' })
    expect(result.steps[0]?.served.channel2[0]).toHaveProperty('contentAbsence', { reason: 'scan-incomplete' })
    expect(JSON.stringify(result)).not.toContain('synthetic private path')
  })

  it('SNAPSHOT-STABLE: five fixed buckets preserve richer attribution and unchanged reads', async () => {
    const snapshot = fixedSnapshot()
    const before = JSON.stringify(snapshot)
    const recorded = snapshot.rows.flatMap(row => row.changes.map(entry => entry.change))
    const diff = recorded.map(row => row.change === 'added'
      ? change({ recordId: row.recordId, change: 'added', atOrdinal: row.atOrdinal, sourceRunId: RUN_ID }) : row)
    const options: DepsOptions = { bindPostProcessing: true, chain: { curationSnapshot: snapshot,
      curateMemory: { status: 'done', claimed: false } }, knowledge: { diffSince: async () => diff,
      showRecords: async ({ recordIds }) => recordIds.map(currentRecord) } }
    const first = await ready(options)
    expect(first.learned).toHaveProperty('curationSnapshot', snapshot)
    expect(first.learned).toHaveProperty('sinceThen', { changes: [], count: 0 })
    expect(first.learned.changes).toHaveLength(7)
    const served = first.learned.curationSnapshot!
    expect(served.rows.map(row => row.bucket).sort()).toEqual(['added', 'confirmed', 'deprecated', 'proposed', 'superseded'])
    expect(Object.values(served.breakdown).reduce((sum, count) => sum + count, 0)).toBe(served.rows.length)
    for (const bucket of ['added', 'confirmed', 'superseded', 'deprecated', 'proposed'] as const) {
      expect(served.breakdown[bucket]).toBe(served.rows.filter(row => row.bucket === bucket).length)
    }
    expect(await ready(options)).toEqual(first)
    expect(JSON.stringify(snapshot)).toBe(before)
    expect(RunKnowledgeProjectionSchema.parse(first)).toEqual(first)
  })

  it('KNOWLEDGE-SNAPSHOT-WITHHELD: an unprojectable snapshot keeps every learned row and names its absence', async () => {
    const snapshot = CurationSnapshotSchema.parse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: ['first-learned', 'second-learned'].map(recordId => ({ recordId, bucket: 'added',
        changes: [{ bucket: 'added', change: change({ recordId, change: 'added', atOrdinal: 20, sourceRunId: RUN_ID }) }] })),
      breakdown: { added: 2, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 } })
    const diff = snapshot.rows.map(row => row.changes[0]!.change)
    const collapsing: MaskFn = text => text.endsWith('-learned') ? 'collapsed-learned' : text
    const options: DepsOptions = { bindPostProcessing: true, chain: { curationSnapshot: snapshot,
      curateMemory: { status: 'done', claimed: false } }, knowledge: { diffSince: async () => diff,
      showRecords: async ({ recordIds }) => recordIds.map(currentRecord) }, secretMask: collapsing }
    await expect(ready(options)).resolves.toMatchObject({ kind: 'ready',
      learned: { curationSnapshotWithheld: { reason: 'projection-refused' } } })
    const result = await ready(options)
    expect(result.learned.changes.map(row => row.recordId)).toEqual(['first-learned', 'second-learned'])
    expect(result.learned.changes).toHaveLength(diff.length)
    expect(result.learned).not.toHaveProperty('curationSnapshot')
    expect(result.learned).not.toHaveProperty('sinceThen')
    expect(result.learned).toHaveProperty('curationSnapshotWithheld', { reason: 'projection-refused' })
    expect(RunKnowledgeProjectionSchema.safeParse(result).success).toBe(true)
    await expect(ready({ ...options, secretMask: null })).rejects.toThrow(/no declared-secret mask/)
  })

  it('LATER-PROMOTION: the same record and a distinct same-ordinal confirmation remain since then', async () => {
    const snapshot = fixedSnapshot()
    const later = [change({ recordId: 'added', change: 'promoted', atOrdinal: 91, sourceRunId: RUN_ID }),
      change({ recordId: 'confirmed', atOrdinal: 21, sourceRunId: RUN_ID, evidenceToken: 'third-confirm', observationId: 'third-observation' })]
    const result = await ready({ bindPostProcessing: true, chain: { curationSnapshot: snapshot },
      knowledge: { diffSince: async () => [...snapshot.rows.flatMap(row => row.changes.map(entry => entry.change)), ...later],
        showRecords: async ({ recordIds }) => recordIds.map(currentRecord) } })
    expect(result.learned).toHaveProperty('curationSnapshot', snapshot)
    expect(result.learned).toHaveProperty('sinceThen', { changes: later.map(row => expect.objectContaining(row)), count: 2 })
  })

  it('SNAPSHOT-ROW-JOIN: every change the fixed snapshot recorded is joined even without a run link', async () => {
    const snapshot = fixedSnapshot()
    const before = JSON.stringify(snapshot)
    const diff = realShapedDiff(snapshot)
    const showRecords = vi.fn(async ({ recordIds }: { recordIds: readonly string[] }) => recordIds.map(currentRecord))
    const result = await ready({ bindPostProcessing: true, chain: { curationSnapshot: snapshot,
      curateMemory: { status: 'done', claimed: false } }, knowledge: { diffSince: async () => diff, showRecords,
      canaryAttributions: async () => ({ rows: [{ candidateId: 'rec-canary', testIndex: 1, stepIndex: 0,
        observationId: 'canary-outcome:elsewhere', outcome: 'confirmed' as const }], skippedBundles: 0 }) } })
    expect(diff.filter(row => row.sourceRunId === undefined).map(row => `${row.recordId}/${row.change}`))
      .toEqual(['confirmed/confirmed', 'confirmed/confirmed', 'deprecated/deprecated', 'victim/superseded'])
    expect(result.learned.changes.map(identityOf)).toEqual(diff.map(identityOf))
    for (const row of snapshot.rows.flatMap(entry => entry.changes.map(recorded => recorded.change))) {
      // A store Add has no receipt token, so the token is compared only where both carry one.
      expect(result.learned.changes.filter(learned => learned.recordId === row.recordId && learned.change === row.change
        && learned.atOrdinal === row.atOrdinal && learned.byRecordId === row.byRecordId
        && (learned.evidenceToken === undefined || learned.evidenceToken === row.evidenceToken)), identityOf(row)).toHaveLength(1)
    }
    for (const row of result.learned.changes) {
      expect(row).toHaveProperty('recordContent.content', `Current body 🧪 ${row.recordId}`)
      expect(row).not.toHaveProperty('contentAbsence')
    }
    expect(result.learned.changes.find(row => row.recordId === 'deprecated')).not.toHaveProperty('sourceRunId')
    expect(new Set(showRecords.mock.calls[0]?.[0].recordIds))
      .toEqual(new Set(['rec-a', 'rec-b', 'rec-c', 'rec-canary', ...diff.map(row => row.recordId)]))
    expect(result.learned).toHaveProperty('sinceThen', { changes: [], count: 0 })
    expect(result.learned).toHaveProperty('curationSnapshot', snapshot)
    expect(JSON.stringify(snapshot)).toBe(before)
    expect(RunKnowledgeProjectionSchema.parse(result)).toEqual(result)
  })

  it('NEIGHBOUR-STAYS-OUT: a same-record change the snapshot did not record is never this run\'s', async () => {
    const snapshot = fixedSnapshot()
    const diff = realShapedDiff(snapshot)
    const neighbours = [
      change({ recordId: 'confirmed', change: 'confirmed', atOrdinal: 30, sourceRunId: OTHER_RUN_ID, evidenceToken: 'neighbour-confirm' }),
      change({ recordId: 'deprecated', change: 'deprecated', atOrdinal: 31, evidenceToken: 'receipt-deprecated' }),
      change({ recordId: 'victim', change: 'superseded', atOrdinal: 32, byRecordId: 'replacement', evidenceToken: 'receipt-victim' }),
    ]
    const result = await ready({ bindPostProcessing: true, chain: { curationSnapshot: snapshot,
      curateMemory: { status: 'done', claimed: false } }, knowledge: { diffSince: async () => [...diff, ...neighbours],
      showRecords: async ({ recordIds }) => recordIds.map(currentRecord) } })
    expect(result.learned.changes.map(identityOf)).toEqual(diff.map(identityOf))
    for (const neighbour of neighbours) {
      expect(result.learned.changes.map(identityOf)).not.toContain(identityOf(neighbour))
    }
    expect(result.learned).toHaveProperty('sinceThen', { changes: [], count: 0 })
  })

  it('FAILED-CHAIN-ROWS-RETAINED: incomplete curation keeps actual changes without invented snapshot/counts', async () => {
    const result = await ready({ bindPostProcessing: true, chain: { curateMemory: { status: 'failed', claimed: false } },
      knowledge: { diffSince: async () => [change({ sourceRunId: RUN_ID })],
        showRecords: async ({ recordIds }) => recordIds.map(currentRecord) } })
    expect(result.curation.status).toBe('failed')
    expect(result.learned.changes).toHaveLength(1)
    expect(result.learned.changes[0]).toMatchObject({ recordId: 'rec-1', change: 'confirmed', atOrdinal: 12 })
    expect(result.learned.changes[0]).toHaveProperty('recordContent')
    expect(result.learned).not.toHaveProperty('curationSnapshot')
    expect(result.learned).not.toHaveProperty('sinceThen')
    expect(result.curation).not.toHaveProperty('counts')
  })

  it('JOINED-STRINGS-MASKED: joined prose crosses the live mask while exact identities stay unmasked', async () => {
    const secret = 'synthetic-secret-9f2c'
    const local = declaredMask({ SECRET_441: secret })
    const secretRecord = (recordId: string) => KnowledgeRecordShowResultSchema.parse({
      kind: 'found', schemaVersion: 2, summary: `summary ${secret}`, body: `body ${secret}`,
      provenance: { schemaVersion: 1, mode: 'standalone', originClass: 'agent-observed', sourceDescription: 'synthetic inspection' },
      record: { schemaVersion: INSPECT_RECORD_VIEW_SCHEMA_VERSION, recordId, product: `shop ${secret}`, scope: 'checkout', kind: 'fact',
        status: 'active', confirmations: 1, contradictions: 0, evidenceTokens: [`token ${secret}`],
        openedAtOrdinal: 3, lastEventOrdinal: 3, anchors: [`el:${secret}`], trustNarrative: `narrative ${secret}` },
    })
    const options: DepsOptions = { knowledge: { diffSince: async () => [change({ recordId: 'rec-a', sourceRunId: RUN_ID })],
      showRecords: async ({ recordIds }) => recordIds.map(secretRecord) }, secretMask: local }
    const masked = await ready(options)
    expect(JSON.stringify(masked)).not.toContain(secret)
    expect(masked.steps[0]?.served.channel1[0]).toMatchObject({ id: 'rec-a', recordContent: {
      content: local(`body ${secret}`), summary: local(`summary ${secret}`),
      applicability: { product: local(`shop ${secret}`), anchors: [local(`el:${secret}`)] },
      currentTrust: { evidenceTokens: [local(`token ${secret}`)], trustNarrative: local(`narrative ${secret}`) } } })
    expect(masked.learned.changes[0]).toMatchObject({ recordId: 'rec-a', sourceRunId: RUN_ID })
    expect(masked.steps[0]?.served.channel1[0]).toHaveProperty('recordContent.content', 'body [secret:SECRET_441]')
    await expect(ready({ ...options, secretMask: null })).rejects.toThrow(/no declared-secret mask/)
    await expect(ready({ ...options, secretMask: () => { throw new Error('synthetic unreadable secrets file') } }))
      .rejects.toThrow('synthetic unreadable secrets file')
  })

  it('JOIN-NOT-BOUND: actual registry retains the read with typed enrichment absence and no unary fallback', async () => {
    const unary = vi.fn(async () => { throw new Error('unary fallback forbidden') })
    const registry = createFunctionRegistry({ deps: deps({ knowledge: { showRecord: unary } }) })
    const result = await invokeFunction(registry, 'runs.knowledge', { runId: RUN_ID },
      { surface: 'cli', origin: 'human' })
    expect(result).toHaveProperty('steps.0.served.channel2.0.contentAbsence', { reason: 'not-bound' })
    expect(unary).not.toHaveBeenCalled()
  })
})

/**
 * The layer's no-null idiom, asserted STRUCTURALLY (407-19, IN-03).
 *
 * Serialising the DTO and searching those bytes for the four letters `n-u-l-l` — the form these
 * cells used before — reds on any record id, step text or CSS selector that merely CONTAINS them.
 * An unrelated fixture change breaks the cell and the failure says nothing about the idiom it was
 * guarding. This walks the parsed value instead and names the path of the offending member, so a
 * failure reads as an instruction.
 */
function assertNoNull(value: unknown, path = '$'): void {
  if (value === null) {
    expect.fail(`null at ${path} — absence in this DTO is an ABSENT KEY, never a null byte`)
  }
  if (Array.isArray(value)) {
    value.forEach((member, index) => assertNoNull(member, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, member] of Object.entries(value as object)) {
      assertNoNull(member, path === '$' ? key : `${path}.${key}`)
    }
  }
}

function notification(
  curation: RunNotification['stages']['curation'],
): RunNotification {
  return {
    schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
    runId: RUN_ID,
    outcome: 'done',
    verdictSummary: { total: 2, byClass: {} },
    stages: { analysis: { status: 'done' }, curation },
  }
}

async function ready(options: DepsOptions = {}) {
  const result = await runsKnowledgeSpec.invoke({ runId: asRunId(RUN_ID) }, deps(options))
  if (result.kind !== 'ready') {
    throw new Error(`expected a ready projection, got ${result.kind}`)
  }
  return result
}

describe('the spec declares a read-tier, everywhere-bound contract', () => {
  it('names its id, scopes and risk the way its read siblings do', () => {
    expect(runsKnowledgeSpec.id).toBe('runs.knowledge')
    // RE-SPELLED 2026-10-01 (432-26, D-12) from `requiredScopes` equal to ['read']: the op declares
    // no scope. Its read tier is the read-only risk pinned below, the same as its read siblings'.
    expect(runsKnowledgeSpec).not.toHaveProperty('requiredScopes')
    expect(runsKnowledgeSpec.resultKind).toBe('unary')
    expect(runsKnowledgeSpec.risk).toEqual({
      name: 'fn:runs.knowledge',
      recognized: true,
      readOnly: true,
    })
  })

  it('declares NO optional-dep binding key — its substrate is the required runs port', () => {
    // The `knowledge.brief.why` footing. A `boundThrough` here would leave a host with no queue
    // database unable to see what its own runs used, which is most of this projection.
    expect(runsKnowledgeSpec.boundThrough).toBeUndefined()
  })

  // RE-SPELLED 2026-10-01 (432-23, D-12): the claim compared each sibling's `requiredScopes` with
  // this op's, so a composed sibling could not need more scope than a `read` caller was granted.
  // Scopes are gone (`knowledge.records.diff` declares none now, and `runs.digest` none since
  // 432-24). What survives is the half a scope stood for: a sibling this read composes must itself
  // be a recognized read-only op, so the composition never performs a mutation the caller did not
  // ask for and no receipt records.
  it('composes only siblings that declare the same read tier it does', () => {
    expect(runsKnowledgeSpec.risk.readOnly).toBe(true)
    for (const spec of [runsPostProcessingSpec, knowledgeRecordsDiffSpec, runsDigestSpec]) {
      expect(spec.risk.readOnly, spec.id).toBe(runsKnowledgeSpec.risk.readOnly)
      expect(spec.risk.recognized, spec.id).toBe(true)
    }
  })
})

describe('the Used half projects every step of every member test', () => {
  it('flat-maps both tests in order and keeps testIndex beside the per-test stepIndex', async () => {
    const result = await ready()

    // Four rows, and the pairs of duplicate `stepIndex` values are exactly why `testIndex` rides:
    // a run with two tests has two step 0s, and a row keyed on stepIndex alone addresses neither.
    expect(result.steps.map((row) => [row.testIndex, row.stepIndex])).toEqual([
      [0, 0], [0, 1], [1, 0], [1, 1],
    ])
    expect(result.steps.map((row) => row.testId)).toEqual(['t_0', 't_0', 't_1', 't_1'])
    expect(result.runId).toBe(RUN_ID)
    expect(result.buildOrdinal).toBe(12)
  })

  it('projects the three channels field by field, keeping the canary marker', async () => {
    const result = await ready()

    expect(result.steps[0]?.served.channel1).toEqual([{
      id: 'rec-a',
      kind: 'fact',
      summary: 'the cart badge counts items',
      trust: 0.8,
      status: 'active',
      servedAsCanary: false,
      tier: 'context',
      contentAbsence: { reason: 'not-bound' },
    }])
    expect(result.steps[0]?.served.channel2).toEqual([
      { id: 'rec-b', detailLevel: 'summary', bodyDigest: 'body-1', contentAbsence: { reason: 'not-bound' } },
    ])
    // Anchors are deliberately NOT projected: the panel renders a caution's sentence only.
    // 423-34: a host binding no batch record read names that absence instead of omitting it.
    expect(result.steps[0]?.served.channel3).toEqual([
      { id: 'rec-c', summary: 'the checkout button moves on mobile', contentAbsence: { reason: 'not-bound' } },
    ])
    expect(result.steps[2]?.served.channel1[0]?.servedAsCanary).toBe(true)
  })

  it('answers each step with the trace it recorded, or the named absence', async () => {
    const result = await ready()

    expect(result.steps[0]?.trace).toEqual({
      kind: 'answered',
      trace: {
        schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: [{ recordId: 'rec-a', leg: 'anchor', rank: 1, score: 0.5 }],
        truncated: [{ recordId: 'rec-cut', leg: 'lexical', rank: 9, score: 0.1 }],
      },
    })
    // The honest absence — never a trace re-derived against today's index (LERN-01's prohibition).
    expect(result.steps[1]?.trace).toEqual({ kind: 'no-trace', reason: 'pre-trace-run' })
  })

  it('passes a replay and a hint plan source through verbatim', async () => {
    const result = await ready()

    expect(result.steps[0]?.planSource).toEqual(REPLAY)
    expect(result.steps[3]?.planSource).toEqual(HINT)
    // A step that replayed nothing carries NO key — a different byte from an empty source.
    expect(result.steps[1] && 'planSource' in result.steps[1]).toBe(false)
  })
})

describe('the plan source is PICKED onto the wire, never spread', () => {
  it('carries the runner-written flow cursor of a real replay onto the wire', async () => {
    // The exact input CR-01 reproduced a `ZodError` with: the arm is `.strict()`, the runner
    // writes `flow` unconditionally, and before 407-12 this refused rather than projected.
    const result = await ready()

    expect(result.steps[0]?.planSource).toEqual(REPLAY)
    expect(result.steps[0]?.planSource).toHaveProperty('flow', { cursor: 0, length: 3 })
  })

  it('keeps every declared member of both arms — the pick is not a narrowing', async () => {
    const result = await ready()

    expect(result.steps[0]?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: 'rec-proc-1',
      guard: {
        checksPassed: 2,
        total: 3,
        miss: { procedureStepIndex: 2, reason: 'page-anchor-mismatch' },
      },
      flow: { cursor: 0, length: 3 },
    })
    expect(result.steps[3]?.planSource).toEqual({
      kind: 'procedure-hint',
      procedureId: 'rec-proc-2',
      demotion: 'body-empty',
    })
  })

  it('drops a producer member this build does not declare, and still parses', async () => {
    // The channels are field-picked so a serving-contract addition cannot silently reach a page
    // (405's display posture). Before CR-01 the plan source alone was SPREAD, so the next
    // producer member would have reached the strict wire and refused the whole read — exactly
    // how `flow` shipped. A field-pick makes that class of break impossible rather than pending.
    const evidence = step(0, {
      planSource: { ...REPLAY, futureMember: 'x' } as unknown as StepPlanSource,
    })
    const result = await runsKnowledgeSpec.invoke(
      { runId: asRunId(RUN_ID) },
      deps({ document: handoff([test(0, [evidence])]) }),
    )

    expect(result.kind).toBe('ready')
    expect(RunKnowledgeProjectionSchema.safeParse(result).success).toBe(true)
    expect(JSON.stringify(result)).not.toContain('futureMember')
  })
})

describe('a pruned handoff is a result, not a throw', () => {
  it('answers evidence-incomplete for a run the runs port cannot load', async () => {
    const result = await runsKnowledgeSpec.invoke(
      { runId: asRunId(RUN_ID) },
      deps({ document: undefined }),
    )

    expect(result).toEqual({ kind: 'evidence-incomplete', runId: RUN_ID })
  })

  it('does not reject — the page renders the state, it does not catch it', async () => {
    await expect(
      runsKnowledgeSpec.invoke({ runId: asRunId(RUN_ID) }, deps({ document: undefined })),
    ).resolves.toBeDefined()
  })
})

describe('the store binding is derived from durable bytes', () => {
  it('reads unbound when every step carries the no-reader truncation and no rung', async () => {
    const document = handoff([
      test(0, [
        step(0, { servedBrief: brief({ truncation: NO_KNOWLEDGE_READER_TRUNCATION }) }),
        step(1, { servedBrief: brief({ truncation: NO_KNOWLEDGE_READER_TRUNCATION }) }),
      ]),
    ])

    const result = await ready({ document })

    expect(result.knowledgeStore).toBe('unbound')
    // A project with no store did not degrade, so there is no rung to report (D-16).
    expect('retrievalRung' in result).toBe(false)
  })

  it('reads bound when even one step served an ordinary brief', async () => {
    const document = handoff([
      test(0, [
        step(0, { servedBrief: brief({ truncation: NO_KNOWLEDGE_READER_TRUNCATION }) }),
        step(1),
      ]),
    ])

    expect((await ready({ document })).knowledgeStore).toBe('bound')
  })
})

describe('the recorded rung is projected per step and at run level', () => {
  it('lifts the first recorded rung to the run and keeps it on the step that carries it', async () => {
    // 407-03 adds `StepEvidence.retrievalRung`; this op reads it forward-compatibly, so the
    // fixture attaches it structurally exactly as the runner will write it.
    const document = handoff([
      test(0, [
        { ...step(0), retrievalRung: RUNG } as StepEvidence,
        step(1),
      ]),
    ])

    const result = await ready({ document })

    expect(result.retrievalRung).toEqual(RUNG)
    expect(result.steps[0]?.retrievalRung).toEqual(RUNG)
    expect(result.steps[1] && 'retrievalRung' in result.steps[1]).toBe(false)
  })

  it('projects no rung at all for a run recorded before rungs existed', async () => {
    const result = await ready()

    expect('retrievalRung' in result).toBe(false)
  })
})

describe('the curation word and its counts mirror the chip', () => {
  it('reads pending with no counts when this host owns no queue database', async () => {
    const result = await ready()

    expect(result.curation.status).toBe('pending')
    expect('counts' in result.curation).toBe(false)
  })

  it('carries counts only when the frozen row recorded BOTH numbers', async () => {
    const result = await ready({
      bindPostProcessing: true,
      chain: {
        curateMemory: { status: 'done', claimed: false },
        notification: notification({ status: 'done', curated: 3, deprecated: 1 }),
      },
    })

    expect(result.curation.status).toBe('complete')
    expect(result.curation.counts).toEqual({ curated: 3, deprecated: 1 })
  })

  it('omits counts when the row recorded only one of them — never a padded zero', async () => {
    const result = await ready({
      bindPostProcessing: true,
      chain: {
        curateMemory: { status: 'done', claimed: false },
        notification: notification({ status: 'done', curated: 3 }),
      },
    })

    expect(result.curation.status).toBe('complete')
    expect('counts' in result.curation).toBe(false)
  })
})

describe('learned changes are attributed, never windowed', () => {
  const MINE = change({ recordId: 'rec-mine', sourceRunId: RUN_ID })
  const BY_OBSERVATION = change({ recordId: 'rec-obs', observationId: 'canary-outcome:abc' })
  const NEIGHBOUR = change({ recordId: 'rec-theirs', sourceRunId: OTHER_RUN_ID })
  const UNATTRIBUTED = change({ recordId: 'rec-orphan' })

  it('keeps only rows this run produced and drops the neighbour and the orphan', async () => {
    const result = await ready({
      knowledge: {
        diffSince: () => Promise.resolve([MINE, BY_OBSERVATION, NEIGHBOUR, UNATTRIBUTED]),
        canaryAttributions: () => Promise.resolve({
          rows: [{
            candidateId: 'rec-canary',
            testIndex: 1,
            stepIndex: 0,
            observationId: 'canary-outcome:abc',
            outcome: 'confirmed' as const,
          }],
          skippedBundles: 0,
        }),
      },
    })

    expect(result.learned.changes.map((row) => row.recordId)).toEqual(['rec-mine', 'rec-obs'])
  })

  it('projects only attributed canary rows, keyed by the step that served the line', async () => {
    const result = await ready({
      knowledge: {
        canaryAttributions: () => Promise.resolve({
          rows: [
            {
              candidateId: 'rec-canary',
              testIndex: 1,
              stepIndex: 0,
              observationId: 'canary-outcome:abc',
              outcome: 'contradicted' as const,
            },
            // A served canary with no surviving attributed event: an ordinary state, and it must
            // NOT become a badge. The panel reads "attribution pending" from the curation word.
            {
              candidateId: 'rec-pending',
              testIndex: 1,
              stepIndex: 1,
              observationId: 'canary-outcome:def',
            },
          ],
          skippedBundles: 0,
        }),
      },
    })

    expect(result.learned.canaryAttributions).toEqual([{
      testIndex: 1,
      stepIndex: 0,
      recordId: 'rec-canary',
      observationId: 'canary-outcome:abc',
      outcome: 'contradicted',
    }])
  })

  it('answers an empty attribution list when the reader binds no attribution method', async () => {
    const result = await ready()

    expect(result.learned.canaryAttributions).toEqual([])
    expect(result.learned.changes).toEqual([])
  })
})

describe('an unrelated malformed bundle degrades the Learned enrichments, never the read', () => {
  // The knowledge store's own fail-closed error, built the way the op must recognise it: BY NAME.
  // `packages/agent` is storage-neutral and cannot import `KnowledgeMaintenanceScanError` from
  // `knowledge-local`, and neither may this file — so the cell constructs the exact wire the op
  // reads (403-03 D-4: read a foreign error structurally, never `instanceof` across a substrate
  // boundary).
  function scanError(path: string): Error {
    return Object.assign(
      new Error(`knowledge maintenance scan incomplete at ${path}: bundle-load: manifest-invalid`),
      { name: 'KnowledgeMaintenanceScanError' },
    )
  }

  const MALFORMED = 'memory/shop/bundles/aaa-malformed-0000000000000000'
  const MINE = change({ recordId: 'rec-mine', sourceRunId: RUN_ID })

  /** `twoByTwo` with a recorded rung on its first step, so the Used half can be SEEN to survive. */
  function withRecordedRung(): CompletedRunHandoff {
    const base = twoByTwo()
    return handoff(base.tests.map((member, testIndex) => (testIndex === 0
      ? {
          ...member,
          steps: member.steps.map((evidence, stepIndex) => (stepIndex === 0
            ? ({ ...evidence, retrievalRung: RUNG } as StepEvidence)
            : evidence)),
        }
      : member)) as PerTestOutcome[])
  }

  it('folds a scan error from the records diff to an empty list and says so on the wire', async () => {
    const result = await ready({
      document: withRecordedRung(),
      knowledge: { diffSince: () => Promise.reject(scanError(MALFORMED)) },
    })

    // The whole Used half is intact — every step, and the rung the run recorded. One malformed
    // bundle this run never touched used to make ALL of this a `read_failed` page.
    expect(result.steps).toHaveLength(4)
    expect(result.retrievalRung).toEqual(RUNG)
    expect(result.learned.changes).toEqual([])
    expect(result.learned.scanIncomplete).toBe(true)
    expect(RunKnowledgeProjectionSchema.safeParse(result).success).toBe(true)
  })

  it('degrades the two enrichments INDEPENDENTLY — a failed attribution keeps the diff rows', async () => {
    const result = await ready({
      knowledge: {
        diffSince: () => Promise.resolve([MINE]),
        canaryAttributions: () => Promise.reject(scanError(MALFORMED)),
      },
    })

    expect(result.learned.canaryAttributions).toEqual([])
    expect(result.learned.changes.map((row) => row.recordId)).toEqual(['rec-mine'])
    expect(result.learned.scanIncomplete).toBe(true)
  })

  it('still propagates an error that is NOT a knowledge-store scan error', async () => {
    // The posture this op has always held, and does not abandon here: a real failure inside a
    // BOUND path is not swallowed. Only the store's own named scan error folds.
    await expect(runsKnowledgeSpec.invoke(
      { runId: asRunId(RUN_ID) },
      deps({ knowledge: { diffSince: () => Promise.reject(new Error('disk on fire')) } }),
    )).rejects.toThrow('disk on fire')
  })

  it('carries NO scanIncomplete key at all on a clean read — never a false', async () => {
    const result = await ready({ knowledge: { diffSince: () => Promise.resolve([MINE]) } })

    expect('scanIncomplete' in result.learned).toBe(false)
    assertNoNull(JSON.parse(JSON.stringify(result)))
  })

  it('names the incomplete scan on the receipt, and leaves a clean receipt byte-identical', async () => {
    const CLEAN = `knowledge for ${RUN_ID} — 4 steps, 2 brief lines served, 0 learned change(s)`
    const degraded = runsKnowledgeSpec.classify(await ready({
      knowledge: { diffSince: () => Promise.reject(scanError(MALFORMED)) },
    }))

    expect(degraded.outcome).toBe(`${CLEAN}, knowledge store scan incomplete`)
    expect(runsKnowledgeSpec.classify(await ready()).outcome).toBe(CLEAN)
  })
})

describe('a partial attribution walk raises the flag by CONTRACT, and the op emits rows beside it', () => {
  // Before 407-19 the ONLY reason a half-read store reached the wire as `scanIncomplete` was that
  // `diffSince` happened to throw on the same bundle. That coupling is not a contract: it does not
  // hold when the two reads see different stores, and it disappears the moment anyone applies
  // 407-14's per-bundle skip to `diffSince` too. The walk now COUNTS what it could not load, and
  // the op reads the flag off that count — so the degradation marker belongs to the read that
  // degraded.
  const MINE = change({ recordId: 'rec-mine', sourceRunId: RUN_ID })

  const ATTRIBUTED = {
    candidateId: 'rec-canary',
    testIndex: 1,
    stepIndex: 0,
    observationId: 'canary-outcome:abc',
    outcome: 'confirmed' as const,
  }

  it('raises scanIncomplete from the walk\'s OWN count, keeping BOTH lists', async () => {
    // The exact projection 407-18's rows-first view renders — now produced by the shipped op from
    // real inputs rather than hand-built in a view fixture: rows on both lists AND the flag.
    const result = await ready({
      knowledge: {
        diffSince: () => Promise.resolve([MINE]),
        canaryAttributions: () => Promise.resolve({ rows: [ATTRIBUTED], skippedBundles: 1 }),
      },
    })

    expect(result.learned.scanIncomplete).toBe(true)
    expect(result.learned.changes.map((row) => row.recordId)).toEqual(['rec-mine'])
    expect(result.learned.canaryAttributions).toEqual([{
      testIndex: 1,
      stepIndex: 0,
      recordId: 'rec-canary',
      observationId: 'canary-outcome:abc',
      outcome: 'confirmed',
    }])
    expect(RunKnowledgeProjectionSchema.safeParse(result).success).toBe(true)
  })

  it('leaves the key ABSENT when the walk read the whole store — a count of 0 is a clean read', async () => {
    const result = await ready({
      knowledge: {
        diffSince: () => Promise.resolve([MINE]),
        canaryAttributions: () => Promise.resolve({ rows: [ATTRIBUTED], skippedBundles: 0 }),
      },
    })

    expect('scanIncomplete' in result.learned).toBe(false)
    expect(result.learned.canaryAttributions).toHaveLength(1)
  })

  it('names the incomplete scan on the receipt for the counted skip, exactly as for the thrown one', async () => {
    const result = await ready({
      knowledge: {
        canaryAttributions: () => Promise.resolve({ rows: [ATTRIBUTED], skippedBundles: 1 }),
      },
    })

    expect(runsKnowledgeSpec.classify(result).outcome).toBe(
      `knowledge for ${RUN_ID} — 4 steps, 2 brief lines served, 0 learned change(s)`
      + ', knowledge store scan incomplete',
    )
  })
})

// RE-SPELLED 432-09 (D-25) from 'the proposals line rides only where an inbox is bound (D-11)': the tab
// shows what changed and never what awaits review, so no host joins a pending-proposal count.
describe('no pending-proposal count rides the projection, inbox bound or not', () => {
  it('carries no pendingProposalCount key on a host with no inbox', async () => {
    const result = await ready()

    expect('pendingProposalCount' in result).toBe(false)
  })

  it('carries no pendingProposalCount key and never lists the inbox when one is bound', async () => {
    const result = await ready({ bindProposalsInbox: true })

    expect('pendingProposalCount' in result).toBe(false)
    expect(runsKnowledgeSpec.output.safeParse({ ...result, pendingProposalCount: 0 }).success).toBe(false)
  })
})

describe('the DTO never carries a null and always validates', () => {
  it('serialises with no null anywhere — absence is an absent key', async () => {
    const result = await ready({
      bindPostProcessing: true,
      chain: { notification: notification({ status: 'done', curated: 1 }) },
    })

    assertNoNull(JSON.parse(JSON.stringify(result)))
  })

  it('the no-null walk names the member it found — the idiom is structural, not textual', () => {
    // The control for the helper above (IN-03): a record id, a step text or a selector carrying
    // the four letters `null` must NOT red these cells, and a real null must red them by PATH.
    expect(() => assertNoNull({ a: [{ b: null }] })).toThrow(/a\[0\]\.b/)
    expect(() => assertNoNull({ recordId: 'rec-[data-null]', steps: ['nullable selector'] }))
      .not.toThrow()
  })

  it('parses against its own declared output contract', async () => {
    const result = await ready()

    expect(runsKnowledgeSpec.output.safeParse(result).success).toBe(true)
  })

  it('folds a receipt line of counts, never of served content', async () => {
    const verdict = runsKnowledgeSpec.classify(await ready())

    expect(verdict.status).toBe('executed')
    expect(verdict.outcome).toBe(
      `knowledge for ${RUN_ID} — 4 steps, 2 brief lines served, 0 learned change(s)`,
    )
    // The brief's own prose stays in `results[]`, where a reader asked for it.
    expect(verdict.outcome).not.toContain('the cart badge counts items')
  })

  it('names the incomplete arm on its receipt too', async () => {
    const result = await runsKnowledgeSpec.invoke(
      { runId: asRunId(RUN_ID) },
      deps({ document: undefined }),
    )

    expect(runsKnowledgeSpec.classify(result)).toEqual({
      status: 'executed',
      outcome: `knowledge for ${RUN_ID} — evidence incomplete`,
    })
  })
})

// ── 423 D-22: versioned rung causes through the existing runs.knowledge read ──────────────────
// Hand-spelled bytes, because this storage-neutral package cannot call the knowledge-local fold.
describe('recorded rung causes on runs.knowledge', () => {
  const CURRENT_FOLDS = [
    { face: 'absent', rung: { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-not-built' } },
    { face: 'locked', rung: { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-locked' } },
    { face: 'corrupt', rung: { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt' } },
    { face: 'schema-version', rung: { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt' } },
  ] as const

  function withRungs(rungs: readonly unknown[]): CompletedRunHandoff {
    return handoff([
      test(0, rungs.map((retrievalRung, stepIndex) => (retrievalRung === undefined
        ? step(stepIndex)
        : ({ ...step(stepIndex), retrievalRung } as StepEvidence)))),
    ])
  }

  function scanError(): Error {
    return Object.assign(new Error('knowledge maintenance scan incomplete at synthetic'), {
      name: 'KnowledgeMaintenanceScanError',
    })
  }

  describe('RUNG-READ-PROPAGATION', () => {
    it.each(CURRENT_FOLDS)('projects the current $face fold byte for byte at run and step level', async ({ rung }) => {
      const result = await ready({ document: withRungs([rung, undefined]) })

      expect(JSON.stringify(result.retrievalRung)).toBe(JSON.stringify(rung))
      expect(JSON.stringify(result.steps[0]?.retrievalRung)).toBe(JSON.stringify(rung))
      expect(result.steps[1] && 'retrievalRung' in result.steps[1]).toBe(false)
      expect(RunKnowledgeProjectionSchema.parse(result)).toEqual(result)
    })

    it('keeps the three causes distinct per step rather than collapsing them', async () => {
      const result = await ready({ document: withRungs(CURRENT_FOLDS.map(({ rung }) => rung)) })

      expect(result.steps.map((row) => row.retrievalRung?.reason)).toEqual([
        'index-not-built',
        'index-locked',
        'index-corrupt',
        'index-corrupt',
      ])
      expect(result.retrievalRung).toEqual(CURRENT_FOLDS[0].rung)
    })

    it('retains scanIncomplete independently of rung health', async () => {
      const degraded = await ready({
        document: withRungs([CURRENT_FOLDS[2].rung]),
        knowledge: { diffSince: () => Promise.reject(scanError()) },
      })
      expect(degraded.retrievalRung).toEqual(CURRENT_FOLDS[2].rung)
      expect(degraded.learned.scanIncomplete).toBe(true)

      const clean = await ready({ document: withRungs([CURRENT_FOLDS[2].rung]) })
      expect(clean.retrievalRung).toEqual(CURRENT_FOLDS[2].rung)
      expect('scanIncomplete' in clean.learned).toBe(false)

      const healthy = await ready({
        document: withRungs([{ schemaVersion: 2, rung: 'memidex' }]),
        knowledge: { diffSince: () => Promise.reject(scanError()) },
      })
      expect(healthy.retrievalRung).toEqual({ schemaVersion: 2, rung: 'memidex' })
      expect(healthy.learned.scanIncomplete).toBe(true)
    })
  })

  describe('RUNG-INVALID-VERSION', () => {
    const INVALID = [
      { schemaVersion: 1, rung: 'bundle-scan', reason: 'index-unavailable' },
      { schemaVersion: 1, rung: 'bundle-scan', reason: 'index-not-built' },
      { schemaVersion: 1, rung: 'bundle-scan', reason: 'index-locked' },
      { schemaVersion: 1, rung: 'bundle-scan', reason: 'index-corrupt' },
      { schemaVersion: 3, rung: 'bundle-scan', reason: 'index-corrupt' },
      { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-missing' },
      { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt', detail: 'synthetic' },
      { rung: 'bundle-scan', reason: 'index-corrupt' },
    ]

    it.each(INVALID)('drops a mislabelled or future rung from its step: %j', async (invalid) => {
      const result = await ready({ document: withRungs([invalid, CURRENT_FOLDS[1].rung]) })

      expect(result.steps[0] && 'retrievalRung' in result.steps[0]).toBe(false)
      expect(result.steps[1]?.retrievalRung).toEqual(CURRENT_FOLDS[1].rung)
      expect(result.retrievalRung).toEqual(CURRENT_FOLDS[1].rung)
    })

    it.each(INVALID)('the wire contract refuses the same value at run level: %j', async (invalid) => {
      const result = await ready({ document: withRungs([CURRENT_FOLDS[1].rung]) })

      expect(RunKnowledgeProjectionSchema.safeParse({ ...result, retrievalRung: invalid }).success)
        .toBe(false)
    })
  })
})

// ---- C432-ALL-OPS-AVAILABLE (432-26, D-12) ------------------------------
//
// `runs.knowledge` and the chip read it composes, `runs.postprocessing`, once required `read`.
// Retried from three callers that differ in surface and origin, and that carry no scope at all,
// both are served every time: each attempt reaches the same ports the same number of times, every
// caller gets the same answer, and no audit row is written.
describe('the run knowledge reads serve every caller', () => {
  it('a retried runs.knowledge and runs.postprocessing are served alike to every caller', async () => {
    const base = deps({
      bindPostProcessing: true,
      chain: {
        curateMemory: { status: 'done', claimed: false },
        notification: notification({ status: 'done', curated: 3, deprecated: 1 }),
      },
    })
    const runReads = vi.fn(base.runs.get)
    const chainReads = vi.fn(base.postProcessing!.readChain)
    const registry = createFunctionRegistry({
      deps: {
        ...base,
        runs: { ...base.runs, get: runReads },
        postProcessing: { ...base.postProcessing!, readChain: chainReads },
      },
    })
    const callers = [
      { surface: 'test', origin: 'agent' },
      { surface: 'cli', origin: 'human' },
      { surface: 'mcp', origin: 'agent' },
    ] as const

    const knowledge: unknown[] = []
    const chips: unknown[] = []
    const reads: { runs: number; chain: number }[] = []
    for (const caller of callers) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = { runs: runReads.mock.calls.length, chain: chainReads.mock.calls.length }
        knowledge.push(await invokeFunction(registry, 'runs.knowledge', { runId: RUN_ID }, caller))
        chips.push(await invokeFunction(registry, 'runs.postprocessing', { runId: RUN_ID }, caller))
        reads.push({
          runs: runReads.mock.calls.length - before.runs,
          chain: chainReads.mock.calls.length - before.chain,
        })
      }
    }

    expect(knowledge).toHaveLength(6)
    expect(knowledge[0]).toHaveProperty('kind', 'ready')
    expect(knowledge[0]).toHaveProperty('curation.counts', { curated: 3, deprecated: 1 })
    expect(knowledge).toEqual(Array.from({ length: 6 }, () => knowledge[0]))
    expect(chips).toEqual(Array.from({ length: 6 }, () => chips[0]))
    expect(reads[0]!.runs).toBeGreaterThan(0)
    expect(reads[0]!.chain).toBeGreaterThan(0)
    expect(reads).toEqual(Array.from({ length: 6 }, () => reads[0]))
  })
})
