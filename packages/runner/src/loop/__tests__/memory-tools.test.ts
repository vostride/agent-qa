import { describe, expect, it, vi } from 'vitest'
import {
  asRecordId,
  servingClusterKey,
  servingRecordMetadata,
} from '@vostride/agent-qa-schema'
import type {
  IndexEntry,
  ReadTrace,
  RecordBody,
  RecordId,
  ScopeKey,
  ServingRecordMetadata,
} from '@vostride/agent-qa-schema'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import { createRecordLedger } from '../record-ledger.js'
import {
  createMemoryTools,
  MEMORY_SEARCH_OMISSION_SAMPLE_LIMIT,
  memorySearchResponseTokenEnvelope,
} from '../memory-tools.js'
import { z } from 'zod'
import { noCautions, servedBrief, servedCautions } from './fixtures/served-trace.js'

const SCOPE: ScopeKey = { tier: 'test', key: 'checkout' }

function entry(
  id: string,
  overrides: Partial<IndexEntry> = {},
): IndexEntry {
  return {
    id: asRecordId(id),
    kind: 'fact',
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    trust: 0.8,
    anchors: [{ t: 'page', route: '/checkout' }],
    status: 'active',
    servedAsCanary: false,
    scope: SCOPE,
    validity: 'current',
    ...overrides,
  }
}

function body(id: string, text: string, evidenceDigest = `digest-${id}`): RecordBody {
  return {
    id: asRecordId(id),
    title: `Title ${id}`,
    body: text,
    anchors: [{ t: 'page', route: '/checkout' }],
    evidenceDigest,
    relations: [],
  }
}

function stubReader(overrides: Partial<KnowledgeHintReader> = {}): KnowledgeHintReader {
  return {
    getRunBrief: vi.fn(() => servedBrief({
      tiers: { L0: '', L1: '', L2: '' },
      lines: [],
      truncation: '',
      admissions: [],
    })),
    search: vi.fn(() => []),
    read: vi.fn(id => body(id, 'body')),
    getCautions: vi.fn(() => noCautions()),
    getProcedure: vi.fn(() => undefined),
    emitCanaryOutcome: vi.fn(),
    ...overrides,
  }
}

function factory(
  reader: KnowledgeHintReader,
  options: {
    readBodyBudget?: number
    searchResultBudget?: number
    recordLedger?: ReturnType<typeof createRecordLedger>
    estimateTokens?: (text: string) => number
    onReadTrace?: (trace: ReadTrace) => void
  } = {},
) {
  return createMemoryTools({
    reader,
    scope: SCOPE,
    asOfBuild: 42,
    searchResultBudget: options.searchResultBudget ?? 10_000,
    readBodyBudget: options.readBodyBudget ?? 100,
    recordLedger:
      options.recordLedger ?? createRecordLedger({ cap: 10, budget: 20_000, seedRecords: [] }),
    estimateTokens: options.estimateTokens ?? (text => text.length),
    onReadTrace: options.onReadTrace,
  })
}

describe('createMemoryTools — Channel 2 retrieval', () => {
  it('exposes exactly the restricted memory.search schema and rejects every privileged field', () => {
    const { tools } = factory(stubReader())
    const searchTool = tools['memory.search'].tool as {
      inputSchema?: z.ZodObject<z.ZodRawShape>
      parameters?: z.ZodObject<z.ZodRawShape>
    }
    const schema = searchTool.inputSchema ?? searchTool.parameters

    expect(schema).toBeDefined()
    expect(Object.keys(schema!.shape).sort()).toEqual([
      'anchors',
      'includeCandidates',
      'kind',
      'query',
    ])

    const base = { query: 'checkout button' }
    for (const injected of [
      { includeSuperseded: true },
      { asOfRange: { from: 1, to: 99 } },
      { scope: { tier: 'global', key: '*' } },
      { asOfBuild: 999 },
    ]) {
      expect(schema!.safeParse({ ...base, ...injected }).success).toBe(false)
    }
  })

  it('threads wrapper-fixed scope and build attribution into every search', async () => {
    const search = vi.fn(() => [entry('record-one')])
    const { tools } = factory(stubReader({ search }))

    await tools['memory.search'].execute({
      query: 'checkout button',
      kind: 'fact',
      anchors: [{ t: 'page', route: '/checkout' }],
      includeCandidates: true,
    })

    expect(search).toHaveBeenCalledWith('checkout button', {
      scope: SCOPE,
      asOfBuild: 42,
      kind: 'fact',
      anchors: [{ t: 'page', route: '/checkout' }],
      includeCandidates: true,
    })
  })

  it('rebinds searches to the active suite member at each turn boundary', async () => {
    const search = vi.fn(() => [entry('record-one')])
    const { tools, beginTurn } = factory(stubReader({ search }))
    const memberScope: ScopeKey = { tier: 'test', key: 'guest-checkout' }

    beginTurn(memberScope)
    await tools['memory.search'].execute({ query: 'guest checkout' })

    expect(search).toHaveBeenCalledWith('guest checkout', {
      scope: memberScope,
      asOfBuild: 42,
    })
  })

  it('accounts read bodies with the injected estimator and refuses calls after exhaustion', async () => {
    const first = body('record-first', 'sixty-token-body', 'digest-first')
    const second = body('record-second', 'forty-token-body', 'digest-second')
    const read = vi
      .fn<KnowledgeHintReader['read']>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const estimateTokens = vi.fn((text: string) =>
      text === first.body ? 60 : text === second.body ? 40 : 0,
    )
    const onReadTrace = vi.fn()
    const { tools, beginTurn, drainReadTraces } = factory(
      stubReader({ read }),
      { estimateTokens, onReadTrace },
    )
    beginTurn(SCOPE, [first.id, second.id])

    await tools['memory.read'].execute({ id: first.id, detailLevel: 'body' })
    await tools['memory.read'].execute({ id: second.id, detailLevel: 'summary' })
    const exhausted = await tools['memory.read'].execute({ id: 'record-third' })

    expect(read).toHaveBeenNthCalledWith(1, first.id, {
      detailLevel: 'body',
      budget: 100,
      scope: SCOPE,
      asOfBuild: 42,
    })
    expect(read).toHaveBeenNthCalledWith(2, second.id, {
      detailLevel: 'summary',
      budget: 40,
      scope: SCOPE,
      asOfBuild: 42,
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(estimateTokens).toHaveBeenNthCalledWith(1, first.body)
    expect(estimateTokens).toHaveBeenNthCalledWith(2, second.body)
    expect(exhausted).toEqual({
      kind: 'read-budget-exhausted',
      budget: 100,
      spent: 100,
    })
    expect(exhausted).not.toHaveProperty('body')
    expect(onReadTrace).toHaveBeenNthCalledWith(1, {
      id: first.id,
      detailLevel: 'body',
      bodyDigest: 'digest-first',
    })
    expect(onReadTrace).toHaveBeenNthCalledWith(2, {
      id: second.id,
      detailLevel: 'summary',
      bodyDigest: 'digest-second',
    })
    expect(drainReadTraces()).toEqual([
      { id: first.id, detailLevel: 'body', bodyDigest: 'digest-first' },
      { id: second.id, detailLevel: 'summary', bodyDigest: 'digest-second' },
    ])
    expect(drainReadTraces()).toEqual([])
  })

  it('restores the complete read-body budget at each planning-turn boundary', async () => {
    const record = body('record-reset', 'complete-turn-budget')
    const read = vi.fn<KnowledgeHintReader['read']>(() => record)
    const { tools, beginTurn, drainReadTraces } = factory(stubReader({ read }), {
      estimateTokens: () => 100,
    })
    beginTurn(SCOPE, [record.id])

    await tools['memory.read'].execute({ id: record.id })
    expect(await tools['memory.read'].execute({ id: record.id })).toMatchObject({
      kind: 'read-budget-exhausted',
    })

    beginTurn(SCOPE, [record.id])
    expect(drainReadTraces()).toEqual([])
    await tools['memory.read'].execute({ id: record.id })

    expect(read).toHaveBeenNthCalledWith(2, record.id, {
      budget: 100,
      scope: SCOPE,
      asOfBuild: 42,
    })
    expect(drainReadTraces()).toHaveLength(1)
  })

  it('journals search and exact read-body admissions in model-exposure order', async () => {
    const found = entry('record-journalled-search', {
      anchors: [{ t: 'page', route: '/search-result' }],
    })
    const returned = body(found.id, 'exact returned body')
    returned.anchors = [{ t: 'page', route: '/read-body' }]
    const ledger = createRecordLedger({ cap: 8, budget: 1_000, seedRecords: [] })
    const estimateTokens = vi.fn((text: string) => {
      if (text === returned.body) return 17
      if (text.includes(String(found.id))) return 11
      return 1
    })
    const { tools, beginTurn } = factory(
      stubReader({
        search: vi.fn(() => [found]),
        read: vi.fn(() => returned),
      }),
      { recordLedger: ledger, estimateTokens },
    )

    ledger.beginStepEvidence()
    beginTurn(SCOPE, [], 3)
    expect(await tools['memory.search'].execute({ query: 'journal order' })).toMatchObject({
      kind: 'search-results',
      entries: [found],
    })
    expect(await tools['memory.read'].execute({ id: found.id })).toEqual({
      kind: 'record',
      record: returned,
    })

    expect(ledger.drainEvidenceEvents()).toEqual([
      {
        ordinal: 0,
        turnOrdinal: 3,
        surface: 'search-result',
        id: found.id,
        sourceId: String(found.id),
        clusterKey: servingClusterKey(found.anchors),
        renderedCost: 11,
        chargeRepeated: true,
      },
      {
        ordinal: 1,
        turnOrdinal: 3,
        surface: 'read-body',
        id: returned.id,
        sourceId: String(returned.id),
        clusterKey: servingClusterKey(returned.anchors),
        renderedCost: 17,
        chargeRepeated: true,
      },
    ])
  })

  it('refuses a direct read before exposing its body when combined admission fails', async () => {
    const returned = body('record-read-refused', 'SECRET_BODY_MUST_NOT_ESCAPE')
    const existing = servingRecordMetadata({
      id: returned.id,
      anchors: returned.anchors,
      renderedCost: 50,
    })
    const ledger = createRecordLedger({
      cap: 1,
      budget: 100,
      seedRecords: [existing],
    })
    const { tools, beginTurn, drainReadTraces } = factory(
      stubReader({ read: vi.fn(() => returned) }),
      {
        recordLedger: ledger,
        estimateTokens: text => text === returned.body ? 1 : text.length,
      },
    )

    ledger.beginStepEvidence()
    beginTurn(SCOPE, [returned.id], 0)
    const result = await tools['memory.read'].execute({ id: returned.id })

    expect(result).toEqual({
      kind: 'read-admission-refused',
      id: returned.id,
      reason: 'source-dominance',
    })
    expect(JSON.stringify(result)).not.toContain(returned.body)
    expect(drainReadTraces()).toEqual([])
    expect(ledger.drainEvidenceEvents()).toEqual([])
    expect(ledger.spent()).toBe(50)
  })

  it('refuses ids not exposed by this turn, including cap drops and relation targets', async () => {
    const exposed = entry('record-exposed')
    const dropped = entry('record-dropped')
    const relationTarget = asRecordId('record-related-hidden')
    const read = vi.fn<KnowledgeHintReader['read']>((id) => ({
      ...body(id, 'body'),
      relations: [{ kind: 'related', targetId: relationTarget }],
    }))
    const ledger = createRecordLedger({ cap: 1, budget: 20_000, seedRecords: [] })
    const { tools, beginTurn } = factory(
      stubReader({ search: vi.fn(() => [exposed, dropped]), read }),
      { recordLedger: ledger },
    )
    beginTurn(SCOPE)

    await tools['memory.search'].execute({ query: 'checkout' })
    expect(await tools['memory.read'].execute({ id: dropped.id })).toEqual({
      kind: 'not-authorized',
      id: dropped.id,
    })
    expect(read).not.toHaveBeenCalled()

    const exposedResult = await tools['memory.read'].execute({ id: exposed.id })
    expect(exposedResult).toMatchObject({
      kind: 'record',
      record: { relations: [{ targetId: relationTarget }] },
    })
    expect(await tools['memory.read'].execute({ id: relationTarget })).toEqual({
      kind: 'not-authorized',
      id: relationTarget,
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('filters new ids at the record cap, preserves counted entries, and reports the drop', async () => {
    const counted = entry('record-counted', {
      servedAsCanary: true,
      unverified: true,
    })
    const dropped = entry('record-dropped')
    const countedMetadata = servingRecordMetadata({
      id: counted.id,
      anchors: counted.anchors,
      renderedCost: 1,
    })
    const ledger = createRecordLedger({
      cap: 1,
      budget: 20_000,
      seedRecords: [countedMetadata],
    })
    const { tools } = factory(
      stubReader({ search: vi.fn(() => [counted, dropped]) }),
      { recordLedger: ledger },
    )

    const result = await tools['memory.search'].execute({ query: 'checkout' })

    expect(result).toEqual({
      kind: 'search-results',
      entries: [counted],
      note: {
        kind: 'search-admission-limited',
        droppedCount: 1,
        omissionCounts: [{
          authority: 'combined-turn',
          reason: 'volume-cap',
          count: 1,
        }],
        sampledOmissions: [{
          id: dropped.id,
          authority: 'combined-turn',
          reason: 'volume-cap',
        }],
        unsampledCount: 0,
        message: 'Search admission limited; inspect structured counts and samples.',
      },
    })
  })

  it('admits a search result at exact-half cost and reports one strictly over half', async () => {
    const exact = entry('record-exact-half', {
      anchors: [{ t: 'page', route: '/exact' }],
    })
    const over = entry('record-over-half', {
      anchors: [{ t: 'page', route: '/over' }],
    })
    const estimateTokens = vi.fn((text: string) => (
      text.includes(String(exact.id)) ? 50 : 51
    ))
    const exactFactory = factory(
      stubReader({ search: vi.fn(() => [exact]) }),
      {
        searchResultBudget: 100,
        estimateTokens,
        recordLedger: createRecordLedger({ cap: 8, budget: 1_000, seedRecords: [] }),
      },
    )
    const overFactory = factory(
      stubReader({ search: vi.fn(() => [over]) }),
      {
        searchResultBudget: 100,
        estimateTokens,
        recordLedger: createRecordLedger({ cap: 8, budget: 1_000, seedRecords: [] }),
      },
    )

    expect(await exactFactory.tools['memory.search'].execute({ query: 'exact' })).toEqual({
      kind: 'search-results',
      entries: [exact],
    })
    expect(await overFactory.tools['memory.search'].execute({ query: 'over' })).toEqual({
      kind: 'search-results',
      entries: [],
      note: {
        kind: 'search-admission-limited',
        droppedCount: 1,
        omissionCounts: [{
          authority: 'search-results',
          reason: 'source-dominance',
          count: 1,
        }],
        sampledOmissions: [{
          id: over.id,
          authority: 'search-results',
          reason: 'source-dominance',
        }],
        unsampledCount: 0,
        message: 'Search admission limited; inspect structured counts and samples.',
      },
    })
  })

  it('resets the cumulative search-result authority at each planning-turn boundary', async () => {
    const candidate = entry('record-search-reset')
    const { tools, beginTurn } = factory(
      stubReader({ search: vi.fn(() => [candidate]) }),
      {
        searchResultBudget: 100,
        estimateTokens: () => 50,
        recordLedger: createRecordLedger({ cap: 8, budget: 1_000, seedRecords: [] }),
      },
    )

    expect(await tools['memory.search'].execute({ query: 'first' })).toMatchObject({
      entries: [candidate],
    })
    expect(await tools['memory.search'].execute({ query: 'repeated' })).toMatchObject({
      entries: [],
      note: {
        sampledOmissions: [{ authority: 'search-results', reason: 'source-dominance' }],
      },
    })

    beginTurn(SCOPE)
    expect(await tools['memory.search'].execute({ query: 'next turn' })).toMatchObject({
      entries: [candidate],
    })
  })

  it('enforces one combined cluster share across brief seeds, cautions, and search', async () => {
    const sharedAnchor = { t: 'page' as const, route: '/shared-checkout-control' }
    const clusterKey = servingClusterKey([sharedAnchor])
    const metadata = (
      id: string,
      renderedCost: number,
    ): ServingRecordMetadata => ({
      id: asRecordId(id),
      sourceId: id,
      clusterKey,
      renderedCost,
    })
    const ledger = createRecordLedger({
      cap: 8,
      budget: 120,
      seedRecords: [metadata('brief-record', 20)],
    })
    // Channel 3 lands before the planner's Channel-2 calls in the live loop.
    expect(ledger.admit(metadata('caution-record', 20))).toEqual({ admitted: true })

    const exact = entry('search-at-combined-half')
    const over = entry('search-over-combined-half')
    const { tools } = factory(
      stubReader({ search: vi.fn(() => [exact, over]) }),
      {
        searchResultBudget: 100,
        estimateTokens: text => text.includes(String(exact.id)) ? 20 : 1,
        recordLedger: ledger,
      },
    )
    // Override the search entries' derived cluster through their shared anchors.
    exact.anchors = [sharedAnchor]
    over.anchors = [sharedAnchor]

    const result = await tools['memory.search'].execute({ query: 'checkout' })

    expect(result).toEqual({
      kind: 'search-results',
      entries: [exact],
      note: {
        kind: 'search-admission-limited',
        droppedCount: 1,
        omissionCounts: [{
          authority: 'combined-turn',
          reason: 'cluster-dominance',
          count: 1,
        }],
        sampledOmissions: [{
          id: over.id,
          authority: 'combined-turn',
          reason: 'cluster-dominance',
        }],
        unsampledCount: 0,
        message: 'Search admission limited; inspect structured counts and samples.',
      },
    })
    expect(ledger.spent()).toBe(60)
  })

  it('bounds a 10,000-match refusal response with exact resettable diagnostics', async () => {
    const totalMatches = 10_000
    const combinedBudget = 48
    const searchResultBudget = 12_000
    const candidates = Array.from(
      { length: totalMatches },
      (_, index) => entry(`record-large-search-${String(index).padStart(5, '0')}`),
    )
    const ledger = createRecordLedger({
      cap: 24,
      budget: combinedBudget,
      seedRecords: [],
    })
    // Candidate projections cost one synthetic token; COMPLETE response serialization is
    // measured byte-for-byte so the assertion below exercises the wrapper envelope itself.
    const estimateTokens = (text: string): number => (
      text.startsWith('{"kind":"search-results"')
        ? new TextEncoder().encode(text).byteLength
        : 1
    )
    const { tools, beginTurn } = factory(
      stubReader({ search: vi.fn(() => candidates) }),
      { searchResultBudget, estimateTokens, recordLedger: ledger },
    )
    const verifyBoundedResult = (raw: unknown): void => {
      const result = raw as {
        kind: 'search-results'
        entries: IndexEntry[]
        note: {
          droppedCount: number
          omissionCounts: Array<{
            authority: string
            reason: string
            count: number
          }>
          sampledOmissions: Array<{
            id: RecordId
            authority: string
            reason: string
          }>
          unsampledCount: number
          message: string
        }
      }

      expect(result.kind).toBe('search-results')
      expect(result.entries).toHaveLength(24)
      expect(new Set(result.entries.map(({ id }) => id)).size).toBe(24)
      expect(result.note.droppedCount).toBe(totalMatches - 24)
      expect(result.note.omissionCounts).toEqual([{
        authority: 'combined-turn',
        reason: 'volume-cap',
        count: totalMatches - 24,
      }])
      expect(result.note.sampledOmissions).toHaveLength(
        MEMORY_SEARCH_OMISSION_SAMPLE_LIMIT,
      )
      expect(result.note.sampledOmissions).toEqual(
        candidates.slice(24, 24 + MEMORY_SEARCH_OMISSION_SAMPLE_LIMIT).map(({ id }) => ({
          id,
          authority: 'combined-turn',
          reason: 'volume-cap',
        })),
      )
      expect(result.note.unsampledCount).toBe(
        totalMatches - 24 - MEMORY_SEARCH_OMISSION_SAMPLE_LIMIT,
      )
      expect(result.note.message).not.toContain('combined-turn')
      expect(result.note.message).not.toContain('volume-cap')
      for (const { id } of result.note.sampledOmissions) {
        expect(result.note.message).not.toContain(String(id))
      }

      const serialized = JSON.stringify(result)
      expect(estimateTokens(serialized)).toBeLessThanOrEqual(
        memorySearchResponseTokenEnvelope(searchResultBudget),
      )
      for (const { id } of result.note.sampledOmissions) {
        expect(serialized.split(String(id))).toHaveLength(2)
      }
      // All admitted entries share one cluster and land exactly at the combined 50% wall.
      expect(ledger.size()).toBe(24)
      expect(ledger.spent()).toBe(combinedBudget / 2)
    }

    beginTurn(SCOPE)
    const first = await tools['memory.search'].execute({ query: 'checkout' })
    verifyBoundedResult(first)

    ledger.resetTurn([])
    beginTurn(SCOPE)
    const second = await tools['memory.search'].execute({ query: 'checkout again' })
    verifyBoundedResult(second)
    expect(second).toEqual(first)
  })

  it('returns structured empty and not-found results instead of throwing', async () => {
    const missingId = asRecordId('record-missing')
    const read = vi.fn(() => undefined) as unknown as KnowledgeHintReader['read']
    const { tools, beginTurn } = factory(stubReader({ search: vi.fn(() => []), read }))
    beginTurn(SCOPE, [missingId])

    expect(tools['memory.search'].execute({ query: 'no match' })).toEqual({
      kind: 'empty-result',
      entries: [],
    })
    expect(tools['memory.read'].execute({ id: missingId })).toEqual({
      kind: 'not-found',
      id: missingId,
    })
  })
})
