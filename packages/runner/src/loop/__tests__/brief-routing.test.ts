import { describe, expect, it } from 'vitest'
import {
  asRecordId,
  computeBriefDigest,
  guardLosslessServedBrief,
  servingRecordMetadata,
} from '@vostride/agent-qa-schema'
import type {
  BriefBlock,
  IndexEntry,
  ProcedureMatch,
  RecordBody,
  ScopeKey,
} from '@vostride/agent-qa-schema'
import type { SystemModelMessage } from 'ai'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import { executeStep } from '../index.js'
import { EvidenceRecorder } from '../evidence.js'
import { createMemoryTools } from '../memory-tools.js'
import { buildContextTier, buildVolatileTier } from '../prompts.js'
import { createRecordLedger, type RecordLedger } from '../record-ledger.js'
import type { StepContext } from '../types.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext } from './loop-harness.js'
import { emptyTrace, noCautions, servedBrief, servedCautions } from './fixtures/served-trace.js'

const scope: ScopeKey = { tier: 'test', key: 'checkout' }
const block: BriefBlock = {
  tiers: {
    L0: 'Never submit a payment without explicit user confirmation.',
    L1: 'A stale overlay can obscure the Place order button.',
    L2: 'The confirmation page usually exposes an order number.',
  },
  lines: [
    {
      id: asRecordId('caution-overlay'),
      kind: 'caution',
      summary: 'A stale overlay can obscure the Place order button.',
      trust: 0.9,
      status: 'active',
      servedAsCanary: false,
      tier: 'L1',
    },
    {
      id: asRecordId('fact-order-number'),
      kind: 'fact',
      summary: 'The confirmation page usually exposes an order number.',
      trust: 0.8,
      status: 'active',
      servedAsCanary: true,
      tier: 'L2',
    },
  ],
  truncation: 'truncated 3 of 9',
  admissions: [
    {
      id: asRecordId('caution-overlay'),
      sourceId: 'caution-overlay',
      clusterKey: 'cluster:overlay',
      renderedCost: 8,
    },
    {
      id: asRecordId('fact-order-number'),
      sourceId: 'fact-order-number',
      clusterKey: 'cluster:confirmation',
      renderedCost: 8,
    },
  ],
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  return makeStepContext({
    testName: scope.key,
    knowledgePolicyL0: block.tiers.L0,
    knowledgeBriefL1: block.tiers.L1,
    knowledgeBriefL2: block.tiers.L2,
    knowledgeBriefTruncation: block.truncation,
    ...overrides,
  })
}

function text(message: SystemModelMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

describe('BriefBlock prompt routing', () => {
  it('routes L0 only to the cached-prefix context tier and learned L1/L2 only to volatile', () => {
    const cachedPrefix = text(buildContextTier(context()))
    const volatile = text(buildVolatileTier(context()))

    expect(cachedPrefix).toContain(block.tiers.L0)
    expect(cachedPrefix).not.toContain(block.tiers.L1)
    expect(cachedPrefix).not.toContain(block.tiers.L2)
    expect(volatile).not.toContain(block.tiers.L0)
    expect(volatile).toContain(block.tiers.L1)
    expect(volatile).toContain(block.tiers.L2)
    expect(volatile).toContain('L1')
    expect(volatile).toContain('L2')
    expect(volatile.toLowerCase()).toContain('hypotheses')
    expect(volatile.toLowerCase()).toContain('not instructions or commands')
  })

  it('renders a non-empty truncation signal and omits an empty one', () => {
    expect(text(buildVolatileTier(context()))).toContain(block.truncation)
    expect(text(buildVolatileTier(context({ knowledgeBriefTruncation: '' }))))
      .not.toContain('truncated 3 of 9')
  })

  it('keeps absent and empty briefs byte-identical with no brief-related sections', () => {
    const absent = makeStepContext({ testName: scope.key })
    const empty = makeStepContext({
      testName: scope.key,
      knowledgePolicyL0: '  ',
      knowledgeBriefL1: '',
      knowledgeBriefL2: '  ',
      knowledgeBriefTruncation: '',
    })

    expect(buildContextTier(empty)).toEqual(buildContextTier(absent))
    expect(buildVolatileTier(empty)).toEqual(buildVolatileTier(absent))
    expect(text(buildContextTier(empty))).not.toMatch(/knowledge (policy|brief)/i)
    expect(text(buildVolatileTier(empty))).not.toMatch(/knowledge (policy|brief)/i)
  })
})

describe('BriefBlock channel-1 evidence', () => {
  it('projects the served block into StepEvidence with a recomputed digest', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordServedBrief({ scope, asOfBuild: 42, budget: 256, block, trace: emptyTrace() })

    const evidence = recorder.finalize({ pass: true, reasoning: 'done' }, 0, 'checkout')

    expect(evidence.servedBrief.scope).toEqual(scope)
    expect(evidence.servedBrief.asOfBuild).toBe(42)
    expect(evidence.servedBrief.budget).toBe(256)
    expect(evidence.servedBrief.truncation).toBe(block.truncation)
    expect(evidence.servedBrief.channel1).toEqual(block.lines)
    expect(evidence.servedBrief.channel2).toEqual([])
    expect(evidence.servedBrief.channel3).toEqual([])
    expect(evidence.servedBrief.briefDigest).toBe(computeBriefDigest(evidence.servedBrief))
  })

  it('records the real reader block through executeStep instead of the empty fallback', async () => {
    const requestedBudgets: number[] = []
    const reader: KnowledgeHintReader = {
      getRunBrief(_scope, budget) {
        requestedBudgets.push(budget)
        return servedBrief(block)
      },
      search() { return [] },
      read() { throw new Error('not used') },
      getCautions() { return noCautions() },
      getProcedure() { return undefined },
      emitCanaryOutcome() {},
    }
    const result = await executeStep(
      'Place the order',
      {
        adapter: makeAdapter(),
        planner: makePlanner([makeActionPlan({ stepComplete: true })]),
        knowledgeReader: reader,
        knowledgeBudgets: {
          brief: 256,
          searchResults: 256,
          caution: 64,
          readBody: 128,
          recordCap: 8,
        },
        knowledgeAsOfBuild: 42,
      },
      context(),
    )

    expect(result.status).toBe('passed')
    expect(requestedBudgets).toEqual([256])
    expect(result.evidence?.servedBrief.channel1).toEqual(block.lines)
    expect(result.evidence?.servedBrief.asOfBuild).toBe(42)
    expect(result.evidence?.servedBrief.budget).toBe(256)
    expect(result.evidence?.servedBrief.truncation).toBe(block.truncation)
    expect(result.evidence?.servedBrief.briefDigest)
      .toBe(computeBriefDigest(result.evidence!.servedBrief))
  })

  it('appends Channel-2 read traces and re-addresses the served brief', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordServedBrief({ scope, asOfBuild: 42, budget: 256, block, trace: emptyTrace() })
    const before = recorder.finalize({ pass: true, reasoning: 'before' }, 0, 'checkout')
      .servedBrief.briefDigest
    const trace = {
      id: asRecordId('fact-order-number'),
      detailLevel: 'body',
      bodyDigest: 'body-digest-order-number',
    }

    recorder.recordServedReadTraces([trace])
    const served = recorder.finalize({ pass: true, reasoning: 'done' }, 0, 'checkout')
      .servedBrief

    expect(served.channel2).toEqual([trace])
    expect(served.briefDigest).not.toBe(before)
    expect(served.briefDigest).toBe(computeBriefDigest(served))
  })

  it('drains live memory.read traces into finalized step evidence', async () => {
    const recordId = asRecordId('fact-order-number')
    const reader: KnowledgeHintReader = {
      getRunBrief: () => servedBrief(block),
      search: () => [],
      read: () => ({
        id: recordId,
        title: 'Order number',
        body: 'The confirmation page exposes an order number.',
        anchors: [{ t: 'page', route: '/confirmation' }],
        evidenceDigest: 'body-digest-order-number',
        relations: [],
      }),
      getCautions: () => noCautions(),
      getProcedure: () => undefined,
      emitCanaryOutcome: () => {},
    }
    const recordLedger = createRecordLedger({ cap: 8, budget: 576, seedRecords: [] })
    const memory = createMemoryTools({
      reader,
      scope,
      asOfBuild: 42,
      searchResultBudget: 256,
      readBodyBudget: 128,
      recordLedger,
      estimateTokens: () => 12,
    })
    const planner = {
      async plan() {
        expect(await memory.tools['memory.read'].execute({ id: recordId })).toMatchObject({
          kind: 'record',
          record: { id: recordId },
        })
        return { plan: makeActionPlan({ stepComplete: true }) }
      },
    }

    const result = await executeStep('Place the order', {
      adapter: makeAdapter(),
      planner,
      knowledgeReader: reader,
      knowledgeBudgets: {
        brief: 256,
        searchResults: 256,
        caution: 64,
        readBody: 128,
        recordCap: 8,
      },
      knowledgeAsOfBuild: 42,
      recordLedger,
      beginMemoryTurn: memory.beginTurn,
      drainMemoryReadTraces: memory.drainReadTraces,
    }, context())

    expect(result.evidence?.servedBrief.channel2).toEqual([{
      id: recordId,
      detailLevel: 'body',
      bodyDigest: 'body-digest-order-number',
    }])
    expect(result.evidence?.servedBrief.briefDigest)
      .toBe(computeBriefDigest(result.evidence!.servedBrief))
    expect(memory.drainReadTraces()).toEqual([])
  })

  it('preserves Channel-2 reads when the live planner fails after using them', async () => {
    const trace = {
      id: asRecordId('fact-order-number'),
      detailLevel: 'body',
      bodyDigest: 'body-digest-before-planner-failure',
    }
    let drained = false
    const reader: KnowledgeHintReader = {
      getRunBrief: () => servedBrief(block),
      search: () => [],
      read: () => undefined,
      getCautions: () => noCautions(),
      getProcedure: () => undefined,
      emitCanaryOutcome: () => {},
    }

    const result = await executeStep('Place the order', {
      adapter: makeAdapter(),
      planner: { plan: async () => { throw new Error('planner stopped after read') } },
      knowledgeReader: reader,
      knowledgeBudgets: {
        brief: 256,
        searchResults: 256,
        caution: 64,
        readBody: 128,
        recordCap: 8,
      },
      drainMemoryReadTraces: () => {
        if (drained) return []
        drained = true
        return [trace]
      },
    }, context())

    expect(result.status).toBe('failed')
    expect(result.evidence?.servedBrief.channel2).toEqual([trace])
    expect(result.evidence?.servedBrief.briefDigest)
      .toBe(computeBriefDigest(result.evidence!.servedBrief))
  })

  it('resets the Channel-2 read ledger after reseeding the shared record ledger', async () => {
    const order: string[] = []
    const recordLedger: RecordLedger = {
      inspect: () => ({ admitted: true }),
      admit: () => ({ admitted: true }),
      resetTurn: (records) => {
        order.push(`records:${records.map(({ id }) => id).join(',')}`)
      },
      size: () => 0,
      spent: () => 0,
    }
    const reader: KnowledgeHintReader = {
      getRunBrief: () => servedBrief(block),
      search: () => [],
      read: () => { throw new Error('not used') },
      getCautions: () => noCautions(),
      getProcedure: () => undefined,
      emitCanaryOutcome: () => {},
    }

    await executeStep(
      'Place the order',
      {
        adapter: makeAdapter(),
        planner: makePlanner([makeActionPlan({ stepComplete: true })]),
        knowledgeReader: reader,
        knowledgeBudgets: {
          brief: 256,
          searchResults: 256,
          caution: 64,
          readBody: 128,
          recordCap: 8,
        },
        recordLedger,
        beginMemoryTurn: (activeScope, exposedIds) => {
          order.push(
            `read-body:${activeScope?.tier}:${activeScope?.key}:${exposedIds?.join(',')}`,
          )
        },
      },
      context(),
    )

    expect(order).toEqual([
      'records:caution-overlay,fact-order-number',
      'read-body:test:checkout:caution-overlay,fact-order-number',
    ])
  })
})

describe('live lossless served-brief proof', () => {
  it('captures ordered production admissions and the exact bytes served on every replan', async () => {
    const promptDate = '2026-07-24'
    const procedureId = asRecordId('procedure-checkout-hint')
    const searchId = asRecordId('fact-checkout-memory')
    const cautionId = asRecordId('caution-checkout-retry')
    const productionBlock: BriefBlock = {
      ...block,
      tiers: {
        ...block.tiers,
        L0: `${block.tiers.L0}\nUse {{secret:CHECKOUT_TOKEN}} only at the execution boundary.`,
      },
    }
    const searchEntry: IndexEntry = {
      id: searchId,
      kind: 'fact',
      title: 'Checkout memory',
      summary: 'Retry the final checkout action after a transient adapter failure.',
      trust: 0.9,
      anchors: [{ t: 'page', route: '/memory-checkout' }],
      status: 'active',
      servedAsCanary: false,
      scope,
      validity: 'current',
    }
    const searchBody: RecordBody = {
      id: searchId,
      title: searchEntry.title,
      body: 'The final checkout action is safe to retry after a transient adapter failure.',
      anchors: searchEntry.anchors,
      evidenceDigest: 'digest-checkout-memory',
      relations: [],
    }
    const procedureMatch: ProcedureMatch = {
      id: procedureId,
      flowAnchor: { t: 'flow', name: 'checkout' },
      confidence: 0.9,
      authoringModelTier: 'full',
      parameterSchema: [],
      replayRecommendation: 'hint',
    }
    const cautionAnchors = [{ t: 'page' as const, route: '/checkout-retry' }]
    const reader: KnowledgeHintReader = {
      getRunBrief: () => servedBrief(productionBlock),
      search: () => [searchEntry],
      read(id) {
        return id === searchId ? searchBody : undefined
      },
      getCautions: () => servedCautions({
        cautions: [{
          id: cautionId,
          anchors: cautionAnchors,
          summary: 'The prior checkout dispatch failed; re-observe before retrying.',
        }],
        budgetUsed: 7,
        admissions: [servingRecordMetadata({
          id: cautionId,
          anchors: cautionAnchors,
          renderedCost: 7,
        })],
      }),
      getProcedure: () => procedureMatch,
      emitCanaryOutcome: () => {},
    }
    const budgets = {
      brief: 256,
      searchResults: 256,
      caution: 128,
      readBody: 128,
      recordCap: 8,
    }
    const combinedBudget = budgets.brief + budgets.searchResults + budgets.caution
    const recordLedger = createRecordLedger({
      cap: budgets.recordCap,
      budget: combinedBudget,
      seedRecords: [],
    })
    const memory = createMemoryTools({
      reader,
      scope,
      asOfBuild: 42,
      searchResultBudget: budgets.searchResults,
      readBodyBudget: budgets.readBody,
      recordLedger,
      estimateTokens: value => Math.max(1, Math.ceil(value.length / 4)),
    })
    const modelTurns: Array<{
      policyL0: string
      learnedL1: string
      learnedL2: string
      contextTier: string
      volatileTier: string
    }> = []
    let plannerCall = 0
    const planner = {
      async plan(_step: string, _screen: unknown, turnContext: StepContext) {
        modelTurns.push({
          policyL0: turnContext.knowledgePolicyL0 ?? '',
          learnedL1: turnContext.knowledgeBriefL1 ?? '',
          learnedL2: turnContext.knowledgeBriefL2 ?? '',
          contextTier: text(buildContextTier(turnContext)),
          volatileTier: text(buildVolatileTier(turnContext)),
        })
        const found = await memory.tools['memory.search'].execute({
          query: 'checkout retry guidance',
        })
        expect(found).toMatchObject({
          kind: 'search-results',
          entries: [{ id: searchId }],
        })
        expect(await memory.tools['memory.read'].execute({ id: searchId })).toMatchObject({
          kind: 'record',
          record: { id: searchId },
        })
        const plan = makeActionPlan({ stepComplete: plannerCall > 0 })
        plannerCall++
        return { plan }
      },
    }

    const result = await executeStep('Place the order', {
      adapter: makeAdapter({
        executeResults: [
          { success: false, error: 'transient checkout dispatch failure' },
          { success: true },
        ],
      }),
      planner,
      knowledgeReader: reader,
      knowledgeBudgets: budgets,
      knowledgeAsOfBuild: 42,
      recordLedger,
      beginMemoryTurn: memory.beginTurn,
      drainMemoryReadTraces: memory.drainReadTraces,
    }, context({
      promptDate,
      variables: { CHECKOUT_TOKEN: 'RESOLVED_RUNTIME_SECRET_MUST_NOT_APPEAR' },
    }))

    expect(result.status).toBe('passed')
    expect(modelTurns).toHaveLength(2)
    const served = guardLosslessServedBrief(result.evidence?.servedBrief)
    expect(served.proof.recordCap).toBe(budgets.recordCap)
    expect(served.proof.combinedBudget).toBe(combinedBudget)
    expect(served.proof.admissionEvents.map(event => event.ordinal))
      .toEqual(served.proof.admissionEvents.map((_event, ordinal) => ordinal))
    expect(served.proof.promptTurns.map(turn => turn.ordinal)).toEqual([0, 1])
    expect(served.proof.promptTurns.map(turn => turn.turnOrdinal)).toEqual([0, 1])
    expect(served.proof.admissionEvents.map(event => `${event.turnOrdinal}:${event.surface}`))
      .toEqual([
        '0:brief-line',
        '0:brief-line',
        '0:procedure-hint',
        '0:search-result',
        '0:read-body',
        '1:brief-line',
        '1:brief-line',
        '1:caution',
        '1:procedure-hint',
        '1:search-result',
        '1:read-body',
      ])
    expect(served.proof.admissionEvents.filter(event => event.surface === 'read-body'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: searchId,
          sourceId: String(searchId),
          chargeRepeated: true,
        }),
      ]))
    for (const [ordinal, turn] of served.proof.promptTurns.entries()) {
      expect(turn.runDate).toBe(promptDate)
      expect(turn.policyL0).toBe(modelTurns[ordinal]!.policyL0)
      expect(turn.learnedL1).toBe(modelTurns[ordinal]!.learnedL1)
      expect(turn.learnedL2).toBe(modelTurns[ordinal]!.learnedL2)
      expect(turn.contextTier).toBe(modelTurns[ordinal]!.contextTier)
      expect(turn.volatileTier).toBe(modelTurns[ordinal]!.volatileTier)
    }
    expect(JSON.stringify(served.proof)).toContain('{{secret:CHECKOUT_TOKEN}}')
    expect(JSON.stringify(served.proof)).not.toContain('RESOLVED_RUNTIME_SECRET_MUST_NOT_APPEAR')
    expect(served.briefDigest).toBe(computeBriefDigest(served))
  })

  it('captures a real prompt and valid zero-record proof when no reader is bound', async () => {
    const modelTurns: Array<{ contextTier: string; volatileTier: string }> = []
    const result = await executeStep('Place the order', {
      adapter: makeAdapter(),
      planner: {
        async plan(_step, _screen, turnContext) {
          modelTurns.push({
            contextTier: text(buildContextTier(turnContext)),
            volatileTier: text(buildVolatileTier(turnContext)),
          })
          return { plan: makeActionPlan({ stepComplete: true }) }
        },
      },
    }, makeStepContext({
      testName: 'No-reader lossless proof',
      testContext: 'Verify checkout without a bound knowledge reader.',
    }))

    expect(result.status).toBe('passed')
    const served = guardLosslessServedBrief(result.evidence?.servedBrief)
    expect(served.proof.admissionEvents).toEqual([])
    expect(served.proof.promptTurns).toHaveLength(1)
    expect(served.proof.promptTurns[0]).toMatchObject({
      ordinal: 0,
      turnOrdinal: 0,
      contextTier: modelTurns[0]!.contextTier,
      volatileTier: modelTurns[0]!.volatileTier,
    })
    expect(served.proof.promptTurns[0]!.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(served.briefDigest).toBe(computeBriefDigest(served))
  })
})
