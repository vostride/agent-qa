// Stub rows are reversed and unsortable, so an op that derives anything fails the projection.

import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, INSPECT_RECORD_VIEW_SCHEMA_VERSION, RECORD_CHANGE_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  BundleProvenance,
  FunctionCaller,
  InspectRecordView,
  RecordChange,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { invokeFunction } from '../invoke.js'
import { createFunctionRegistry } from '../registry.js'
import { agentAskSpec } from '../ops/agent-ask.js'
import { analysisGetSpec } from '../ops/analysis-get.js'
import { configTargetCreateSpec } from '../ops/config-target-create.js'
import { explainSpec } from '../ops/explain.js'
import { knowledgeAcceptSpec } from '../ops/knowledge-accept-propose.js'
import { knowledgeRecordShowSpec } from '../ops/knowledge-record-show.js'
import { knowledgeRecordsDiffSpec } from '../ops/knowledge-records-diff.js'
import { knowledgeRecordsInspectSpec } from '../ops/knowledge-records-inspect.js'
import { knowledgeRejectSpec } from '../ops/knowledge-reject-propose.js'
import { runsKnowledgeSpec } from '../ops/runs-knowledge.js'
import { runsPostProcessingSpec } from '../ops/runs-post-processing.js'
import type {
  FunctionDeps,
  KnowledgeChangeRequest,
  KnowledgeReaderPort,
  KnowledgeReviewPort,
} from '../spec.js'

function view(overrides: Partial<InspectRecordView> = {}): InspectRecordView {
  return {
    schemaVersion: INSPECT_RECORD_VIEW_SCHEMA_VERSION,
    recordId: 'rec-1',
    product: 'shop',
    scope: 'product:shop',
    kind: 'fact',
    status: 'active',
    confirmations: 3,
    contradictions: 0,
    evidenceTokens: ['tok-a'],
    lastEventOrdinal: 12,
    openedAtOrdinal: 4,
    anchors: ['{"route":"/cart","t":"page"}'],
    ...overrides,
  }
}

function change(overrides: Partial<RecordChange> = {}): RecordChange {
  return {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
    recordId: 'rec-1',
    change: 'confirmed',
    atOrdinal: 7,
    ...overrides,
  }
}

const PROVENANCE: BundleProvenance = {
  schemaVersion: 1,
  mode: 'run-linked',
  originClass: 'agent-verified',
  runId: 'run-alpha',
  testId: 't_checkout',
  stepIndex: 2,
}

/** The empty store: every verb answers, none of them throws. */
const EMPTY_KNOWLEDGE: KnowledgeReaderPort = {
  listBundles: () => Promise.resolve([]),
  inspectRecords: () => Promise.resolve([]),
  diffSince: () => Promise.resolve([]),
  showRecord: ({ recordId }) => Promise.resolve({
    kind: 'not-found',
    schemaVersion: 2,
    recordId,
  }),
}

function deps(knowledge: Partial<KnowledgeReaderPort> = {}): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: { ...EMPTY_KNOWLEDGE, ...knowledge },
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
}

describe('the three read verbs declare read-only unary contracts', () => {
  it('names its id, scope and risk the way the exemplar does', () => {
    const specs = [
      knowledgeRecordsInspectSpec,
      knowledgeRecordsDiffSpec,
      knowledgeRecordShowSpec,
    ]

    expect(specs.map((spec) => spec.id)).toEqual([
      'knowledge.records.inspect',
      'knowledge.records.diff',
      'knowledge.record.show',
    ])
    for (const spec of specs) {
      expect(spec, spec.id).not.toHaveProperty('requiredScopes')
      expect(spec.resultKind, spec.id).toBe('unary')
      // Bound wherever registered: `knowledge` is a REQUIRED dep, so unlike the mutating half
      // there is no host that lists these and then refuses them.
      expect(spec.boundThrough, spec.id).toBeUndefined()
      expect(spec.risk, spec.id).toEqual({
        name: `fn:${spec.id}`,
        recognized: true,
        readOnly: true,
      })
    }
  })
})

describe('Test 1 — wiring parity: the ops project, they never recompute', () => {
  it('inspect hands back the reader\'s own view rows, field for field', async () => {
    // Values chosen so no derivation could produce them: a record with more contradictions
    // than confirmations that is still `active`, and an ordinal pair the other way round from
    // what a recomputation would infer. An op that recomputed anything would disagree here.
    const rows = [
      view({ recordId: 'rec-9', confirmations: 0, contradictions: 5, status: 'active' }),
      view({ recordId: 'rec-2', product: 'atlas', lastEventOrdinal: 1, openedAtOrdinal: 99 }),
    ]

    const result = await knowledgeRecordsInspectSpec.invoke(
      { filter: {} },
      deps({ inspectRecords: () => Promise.resolve(rows) }),
    )

    expect(result.schemaVersion).toBe(2)
    expect([...result.records].sort((a, b) => a.recordId.localeCompare(b.recordId)))
      .toEqual([...rows].sort((a, b) => a.recordId.localeCompare(b.recordId)))
  })

  it('inspect passes the caller\'s filter through unchanged', async () => {
    const seen: unknown[] = []

    await knowledgeRecordsInspectSpec.invoke(
      { filter: { product: 'shop', status: 'deprecated', unresolvedOnly: true } },
      deps({
        inspectRecords: (input) => {
          seen.push(input.filter)
          return Promise.resolve([])
        },
      }),
    )

    // A filter the op narrowed, widened or defaulted would be a second query planner living
    // above the one that already exists.
    expect(seen).toEqual([{ product: 'shop', status: 'deprecated', unresolvedOnly: true }])
  })

  it('diff hands back the reader\'s change rows and ECHOES the baseline it was asked for',
    async () => {
      const rows = [change({ recordId: 'rec-3', change: 'purged', atOrdinal: 41 })]

      const result = await knowledgeRecordsDiffSpec.invoke(
        { sinceOrdinal: 12 },
        deps({ diffSince: () => Promise.resolve(rows) }),
      )

      expect(result.schemaVersion).toBe(2)
      expect(result.changes).toEqual(rows)
      // The echo is not decoration: a change list with no baseline is a list whose meaning
      // depends on remembering the question, and these answers get pasted into issues.
      expect(result.sinceOrdinal).toBe(12)
    })

  it('diff passes the caller\'s ordinal through unchanged', async () => {
    const seen: number[] = []

    await knowledgeRecordsDiffSpec.invoke(
      { sinceOrdinal: 0 },
      deps({
        diffSince: ({ sinceOrdinal }) => {
          seen.push(sinceOrdinal)
          return Promise.resolve([])
        },
      }),
    )

    // Zero specifically: an op that treated a falsy ordinal as "unset" would silently answer a
    // different question, and 0 is the ordinal a first-ever diff asks from.
    expect(seen).toEqual([0])
  })
})

describe('Test 2 — show returns the record with its provenance, and types its miss', () => {
  it('carries the record, its provenance, and the prose that goes with them', async () => {
    const record = view({ recordId: 'rec-7' })

    const result = await knowledgeRecordShowSpec.invoke(
      { recordId: 'rec-7' },
      deps({
        showRecord: () => Promise.resolve({
          kind: 'found',
          schemaVersion: 2,
          record,
          provenance: PROVENANCE,
          summary: 'the cart badge lags one tick behind',
          body: 'full prose',
        }),
      }),
    )

    expect(result.kind).toBe('found')
    if (result.kind !== 'found') throw new Error('unreachable')
    expect(result.record).toEqual(record)
    // A record shown without its provenance is an assertion; shown with it, it is evidence.
    expect(result.provenance).toEqual(PROVENANCE)
    expect(result.summary).toBe('the cart badge lags one tick behind')
    expect(result.body).toBe('full prose')
  })

  it('returns a typed not-found for an unknown record id rather than throwing', async () => {
    const result = await knowledgeRecordShowSpec.invoke(
      { recordId: 'rec-nobody-committed' },
      deps(),
    )

    expect(result).toEqual({
      kind: 'not-found',
      schemaVersion: 2,
      recordId: 'rec-nobody-committed',
    })
  })

  it('passes the caller\'s record id through unchanged', async () => {
    const seen: string[] = []

    await knowledgeRecordShowSpec.invoke(
      { recordId: '../../etc/passwd' },
      deps({
        showRecord: ({ recordId }) => {
          seen.push(recordId)
          return Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId })
        },
      }),
    )

    // Verbatim: the reader resolves ids against the records it enumerates, never by a path join.
    expect(seen).toEqual(['../../etc/passwd'])
  })
})

describe('Test 3 — the empty store answers, it never throws (empty edge)', () => {
  it('inspect returns an empty record list', async () => {
    expect(await knowledgeRecordsInspectSpec.invoke({ filter: {} }, deps()))
      .toEqual({ schemaVersion: 2, records: [] })
  })

  it('diff returns an empty change list that still echoes its baseline', async () => {
    expect(await knowledgeRecordsDiffSpec.invoke({ sinceOrdinal: 5 }, deps()))
      .toEqual({ schemaVersion: 2, sinceOrdinal: 5, changes: [] })
  })

  it('show returns the typed miss', async () => {
    expect((await knowledgeRecordShowSpec.invoke({ recordId: 'rec-1' }, deps())).kind)
      .toBe('not-found')
  })
})

describe('Test 4 — each op owns a deterministic TOTAL order', () => {
  it('inspect sorts by record id then product, whatever order the port answered in',
    async () => {
      // Deliberately reversed, and with one record id shared across two products so the second
      // key is load-bearing rather than decorative. A port that happened to answer in order
      // would leave the op's sort unpinned by this case.
      const rows = [
        view({ recordId: 'rec-9', product: 'shop' }),
        view({ recordId: 'rec-2', product: 'shop' }),
        view({ recordId: 'rec-2', product: 'atlas' }),
      ]

      const result = await knowledgeRecordsInspectSpec.invoke(
        { filter: {} },
        deps({ inspectRecords: () => Promise.resolve(rows) }),
      )

      expect(result.records.map((row) => `${row.recordId}/${row.product}`)).toEqual([
        'rec-2/atlas',
        'rec-2/shop',
        'rec-9/shop',
      ])
    })

  it('diff breaks equal keys deterministically all the way down', async () => {
    // Every pair below is equal on every key before the one that separates it, so each leg of
    // the comparator is the only thing that can order that pair. A comparator missing any leg
    // leaves two of these rows in the order the port supplied them.
    const rows = [
      change({ recordId: 'rec-2', atOrdinal: 9, change: 'confirmed', evidenceToken: 'tok-b' }),
      change({ recordId: 'rec-2', atOrdinal: 9, change: 'confirmed', evidenceToken: 'tok-a' }),
      change({ recordId: 'rec-2', atOrdinal: 9, change: 'confirmed' }),
      change({ recordId: 'rec-2', atOrdinal: 9, change: 'added' }),
      change({ recordId: 'rec-2', atOrdinal: 3, change: 'promoted' }),
      change({ recordId: 'rec-1', atOrdinal: 88, change: 'purged' }),
    ]

    const first = await knowledgeRecordsDiffSpec.invoke(
      { sinceOrdinal: 0 },
      deps({ diffSince: () => Promise.resolve(rows) }),
    )
    const second = await knowledgeRecordsDiffSpec.invoke(
      { sinceOrdinal: 0 },
      // The same rows in a DIFFERENT order: two invocations agreeing is only evidence of a
      // total order if the inputs they agreed from were not already in it.
      deps({ diffSince: () => Promise.resolve([...rows].reverse()) }),
    )

    expect(first.changes.map((row) => (
      `${row.recordId}/${String(row.atOrdinal)}/${row.change}/${row.evidenceToken ?? '-'}`
    ))).toEqual([
      'rec-1/88/purged/-',
      'rec-2/3/promoted/-',
      'rec-2/9/added/-',
      'rec-2/9/confirmed/-',
      'rec-2/9/confirmed/tok-a',
      'rec-2/9/confirmed/tok-b',
    ])
    expect(second.changes).toEqual(first.changes)
  })

  it('inspect produces the identical order from two differently-ordered answers', async () => {
    const rows = [
      view({ recordId: 'rec-4' }),
      view({ recordId: 'rec-1', product: 'atlas' }),
      view({ recordId: 'rec-4', product: 'atlas' }),
    ]

    const forward = await knowledgeRecordsInspectSpec.invoke(
      { filter: {} },
      deps({ inspectRecords: () => Promise.resolve(rows) }),
    )
    const reversed = await knowledgeRecordsInspectSpec.invoke(
      { filter: {} },
      deps({ inspectRecords: () => Promise.resolve([...rows].reverse()) }),
    )

    expect(reversed.records).toEqual(forward.records)
  })
})

// Declarations omit retired keys whatever a spec spells, so only the spec shows a key is gone.
describe('the post-processing, knowledge, ask, target-create, analysis and explain op specs carry no permission metadata', () => {
  const migrated = [
    { spec: runsPostProcessingSpec, resultKind: 'unary', boundThrough: 'postProcessing',
      risk: { name: 'fn:runs.postprocessing', recognized: true, readOnly: true } },
    { spec: knowledgeAcceptSpec, resultKind: 'unary', boundThrough: 'knowledgeReview',
      risk: { name: 'fn:knowledge.accept', recognized: true, readOnly: false } },
    { spec: knowledgeRecordsInspectSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:knowledge.records.inspect', recognized: true, readOnly: true } },
    { spec: knowledgeRecordShowSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:knowledge.record.show', recognized: true, readOnly: true } },
    { spec: knowledgeRejectSpec, resultKind: 'unary', boundThrough: 'knowledgeReview',
      risk: { name: 'fn:knowledge.reject', recognized: true, readOnly: false } },
    { spec: agentAskSpec, resultKind: 'unary', boundThrough: 'chatTurn',
      risk: { name: 'fn:agent.ask', recognized: true, readOnly: false } },
    { spec: configTargetCreateSpec, resultKind: 'unary', boundThrough: 'configWrite',
      risk: { name: 'fn:config.target.create', recognized: true, readOnly: false } },
    { spec: analysisGetSpec, resultKind: 'unary', boundThrough: 'analysis',
      risk: { name: 'fn:analysis.get', recognized: true, readOnly: true } },
    { spec: runsKnowledgeSpec, resultKind: 'unary', boundThrough: undefined,
      risk: { name: 'fn:runs.knowledge', recognized: true, readOnly: true } },
    { spec: explainSpec, resultKind: 'unary', boundThrough: 'capabilityCatalog',
      risk: { name: 'fn:agent.explain', recognized: true, readOnly: true } },
  ] as const

  it('spells neither retired permission key on any of the ten specs', () => {
    expect(migrated.map(({ spec }) => spec.id)).toEqual([
      'runs.postprocessing',
      'knowledge.accept',
      'knowledge.records.inspect',
      'knowledge.record.show',
      'knowledge.reject',
      'agent.ask',
      'config.target.create',
      'analysis.get',
      'runs.knowledge',
      'agent.explain',
    ])
    for (const { spec } of migrated) {
      expect(Object.keys(spec), spec.id).not.toContain('requiredScopes')
      expect(Object.keys(spec), spec.id).not.toContain('requiresHumanOrigin')
    }
  })

  it('keeps each spec\'s result kind, binding need, risk descriptor and classify fold', () => {
    for (const { spec, resultKind, boundThrough, risk } of migrated) {
      expect(spec.resultKind, spec.id).toBe(resultKind)
      expect(spec.boundThrough, spec.id).toBe(boundThrough)
      expect(spec.risk, spec.id).toEqual(risk)
      expect(typeof spec.classify, spec.id).toBe('function')
      expect(typeof spec.invoke, spec.id).toBe('function')
    }
    // None of the ten discloses or declares an output representation.
    expect(migrated.filter(({ spec }) => 'disclose' in spec).map(({ spec }) => spec.id)).toEqual([])
    expect(migrated.filter(({ spec }) => 'outputRepresentation' in spec).map(({ spec }) => spec.id))
      .toEqual([])
  })
})

// Every caller is served; the port is reached once per attempt and no audit row is written.
describe('the knowledge accept, reject, inspect and show verbs serve every caller', () => {
  it('a retried accept, reject, inspect and show are served alike to every caller', async () => {
    const changes: KnowledgeChangeRequest[] = []
    const filters: unknown[] = []
    const shown: string[] = []
    const knowledgeReview: KnowledgeReviewPort = {
      change(request) {
        changes.push(request)
        return Promise.resolve({
          outcome: 'applied',
          verb: request.verb,
          operationId: request.operationId ?? 'minted-by-the-stub',
          recordIds: ['rec-1'],
        })
      },
    }
    const registry = createFunctionRegistry({
      deps: {
        ...deps({
          inspectRecords: (input) => {
            filters.push(input.filter)
            return Promise.resolve([view()])
          },
          showRecord: ({ recordId }) => {
            shown.push(recordId)
            return Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId })
          },
        }),
        knowledgeReview,
      },
    })
    const callers: readonly FunctionCaller[] = [
      { surface: 'test', origin: 'agent' },
      { surface: 'cli', origin: 'human' },
      { surface: 'mcp', origin: 'agent' },
    ]
    const target = { grain: 'record', recordId: 'rec-1' } as const

    const answers: unknown[] = []
    for (const caller of callers) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        answers.push(await invokeFunction(registry, 'knowledge.accept',
          { target, operationId: 'accept-op-1' }, caller))
        answers.push(await invokeFunction(registry, 'knowledge.reject',
          { target, reason: 'stale selector', operationId: 'reject-op-1' }, caller))
        answers.push(await invokeFunction(registry, 'knowledge.records.inspect',
          { filter: { product: 'shop' } }, caller))
        answers.push(await invokeFunction(registry, 'knowledge.record.show',
          { recordId: 'rec-9' }, caller))
      }
    }

    // The retry keeps its operation id, so the writer behind the port can land it once.
    expect(changes).toEqual(Array.from({ length: 6 }, () => [
      { verb: 'accept', input: { target }, operationId: 'accept-op-1' },
      { verb: 'reject', input: { target, reason: 'stale selector' }, operationId: 'reject-op-1' },
    ]).flat())
    expect(filters).toEqual(Array.from({ length: 6 }, () => ({ product: 'shop' })))
    expect(shown).toEqual(Array.from({ length: 6 }, () => 'rec-9'))
    expect(answers).toEqual(Array.from({ length: 6 }, () => answers.slice(0, 4)).flat())
    expect(answers.slice(0, 2)).toEqual([
      { outcome: 'applied', verb: 'accept', operationId: 'accept-op-1', recordIds: ['rec-1'] },
      { outcome: 'applied', verb: 'reject', operationId: 'reject-op-1', recordIds: ['rec-1'] },
    ])
  })
})
