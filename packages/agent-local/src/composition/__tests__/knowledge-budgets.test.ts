import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  asRecordId,
  type ModelCapabilities,
  type RecordedRetrievalRung,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { LLMPlanner } from '@vostride/agent-qa-runner'
import type { KnowledgeHintReader, NonActionToolMap } from '@vostride/agent-qa-runner'
import { createFrozenKnowledgeReader } from '../knowledge-reader.js'
import { openRunKnowledgeComposition } from '../run-composition.js'
import {
  BRIEF_CEILING,
  BRIEF_FRACTION,
  GLOBAL_RECORD_CAP,
  MIN_BRIEF,
  MIN_CAUTION,
  MIN_MEMORY_TOOL_CONTEXT_WINDOW,
  WEAK_MODEL_CAP_SCALE,
  computeKnowledgeBudgets,
  memoryToolGate,
  scaledRecordCap,
} from '../knowledge-budgets.js'

// The rung resolver is a required injection; a fake keeps these budget cells off the machine probe.
const fakeResolveRetrievalRung = (): Promise<RecordedRetrievalRung> => Promise.resolve({
  schemaVersion: 2,
  rung: 'bundle-scan',
  reason: 'index-unavailable',
})

function capabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    text: true,
    vision: true,
    visionToolMessages: true,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    contextWindow: MIN_MEMORY_TOOL_CONTEXT_WINDOW,
    maxOutput: 4_096,
    ...overrides,
  }
}

function budgetsForAvailable(available: number) {
  return computeKnowledgeBudgets({
    contextWindow: available,
    reservedOutput: 0,
    qaRulesTokens: 0,
    workingContextTokens: 0,
  })
}

describe('computeKnowledgeBudgets', () => {
  it('clamps a below-floor brief to a non-zero minimum and preserves the first raw token above it', () => {
    const availableForBelowFloor = Math.ceil((MIN_BRIEF - 1) / BRIEF_FRACTION)
    const availableForOneAboveFloor = Math.ceil((MIN_BRIEF + 1) / BRIEF_FRACTION)

    expect(budgetsForAvailable(availableForBelowFloor).brief).toBe(MIN_BRIEF)
    expect(MIN_BRIEF).toBeGreaterThan(0)
    expect(budgetsForAvailable(availableForOneAboveFloor).brief).toBe(MIN_BRIEF + 1)
    expect(budgetsForAvailable(availableForOneAboveFloor).searchResults).toBe(MIN_BRIEF + 1)
  })

  it('floors the fractional product before clamping and caps oversized briefs', () => {
    const fractionalAvailable = Math.ceil((MIN_BRIEF + 10.75) / BRIEF_FRACTION)
    const expectedRaw = Math.floor(fractionalAvailable * BRIEF_FRACTION)

    expect(budgetsForAvailable(fractionalAvailable).brief).toBe(expectedRaw)
    expect(budgetsForAvailable(Number.MAX_SAFE_INTEGER).brief).toBe(BRIEF_CEILING)
  })

  it('keeps the caution budget at a non-zero floor when no usable context remains', () => {
    const result = computeKnowledgeBudgets({
      contextWindow: 1_024,
      reservedOutput: 1_024,
      qaRulesTokens: 4_000,
      workingContextTokens: 4_000,
    })

    expect(result.caution).toBe(MIN_CAUTION)
    expect(result.caution).toBeGreaterThan(0)
  })
})

describe('memoryToolGate', () => {
  it('rejects each weak-model axis and accepts a fully capable profile', () => {
    expect(memoryToolGate(capabilities({ toolCalling: false }))).toBe(false)
    expect(memoryToolGate(capabilities({ vision: false }))).toBe(false)
    expect(memoryToolGate(capabilities({ contextWindow: MIN_MEMORY_TOOL_CONTEXT_WINDOW - 1 }))).toBe(false)
    expect(memoryToolGate(capabilities())).toBe(true)
  })

  it('uses the same predicate to scale the global distinct-record cap', () => {
    expect(scaledRecordCap(capabilities({ vision: false }))).toBe(
      Math.max(1, Math.floor(GLOBAL_RECORD_CAP * WEAK_MODEL_CAP_SCALE)),
    )
    expect(scaledRecordCap(capabilities())).toBe(GLOBAL_RECORD_CAP)
  })
})

describe('run knowledge composition', () => {
  it('freezes one byte-identical brief per canonical scope for a multi-test run', () => {
    let calls = 0
    const reader: KnowledgeHintReader = {
      getRunBrief(scope) {
        calls += 1
        return {
          brief: {
            tiers: { L0: '', L1: '', L2: `${scope.tier}:${scope.key}:${calls}` },
            lines: [],
            truncation: '',
            admissions: [],
          },
          // A different trace per call: a repeat serve carries the real assembly's attribution.
          trace: {
            schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
            servedLines: [{
              recordId: `served-${calls}`,
              leg: 'anchor',
              rank: 1,
              score: calls,
            }],
            truncated: [],
          },
        }
      },
      search: () => [],
      read: () => { throw new Error('not used') },
      getCautions: () => ({
        block: { cautions: [], budgetUsed: 0, admissions: [] },
        trace: { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [], truncated: [] },
      }),
      getProcedure: () => undefined,
      emitCanaryOutcome: () => {},
    }
    const frozen = createFrozenKnowledgeReader(reader)
    const firstScope = { tier: 'test', key: 'checkout' } as const
    const secondScope = { tier: 'test', key: 'refund' } as const

    const first = frozen.getRunBrief(firstScope, 256)
    const repeated = frozen.getRunBrief({ ...firstScope }, 2_048)
    const second = frozen.getRunBrief(secondScope, 256)
    const secondRepeated = frozen.getRunBrief({ ...secondScope }, 2_048)

    expect(repeated).toBe(first)
    expect(secondRepeated).toBe(second)
    expect(second).not.toBe(first)
    expect(calls).toBe(2)
    // The frozen composite carries the SERVE-TIME trace on every repeat, and each scope keeps its
    // own. Without this the memo could have been narrowed back to the brief alone and the trace
    // re-derived per call with nothing noticing.
    expect(first.trace.servedLines[0]?.recordId).toBe('served-1')
    expect(repeated.trace).toBe(first.trace)
    expect(second.trace.servedLines[0]?.recordId).toBe('served-2')
    expect(secondRepeated.trace).toBe(second.trace)
  })

  it('constructs LLMPlanner with no memory surface for text-only models and both tools for capable models', () => {
    const knowledgeRoot = mkdtempSync(join(tmpdir(), 'knowledge-composition-'))
    const accounting = {
      getCeilings: () => ({ contextWindow: 32_768, maxOutput: 4_096 }),
      estimate: () => 32,
    }
    const scope = { tier: 'test', key: 'checkout' } as const
    const weak = openRunKnowledgeComposition({
      knowledgeRoot,
      product: 'shop',
      scope,
      asOfBuild: 7,
      capabilities: capabilities({ vision: false, contextWindow: 32_768 }),
      accounting,
      qaRulesText: 'rules',
      workingContextText: 'checkout context',
      resolveRetrievalRung: fakeResolveRetrievalRung,
    })
    const capable = openRunKnowledgeComposition({
      knowledgeRoot,
      product: 'shop',
      scope,
      asOfBuild: 7,
      capabilities: capabilities({ contextWindow: 32_768 }),
      accounting,
      qaRulesText: 'rules',
      workingContextText: 'checkout context',
      resolveRetrievalRung: fakeResolveRetrievalRung,
    })

    const weakPlanner = new LLMPlanner(
      {} as never,
      'web',
      undefined,
      undefined,
      accounting as never,
      undefined,
      weak.nonActionTools,
    )
    const capablePlanner = new LLMPlanner(
      {} as never,
      'web',
      undefined,
      undefined,
      accounting as never,
      undefined,
      capable.nonActionTools,
    )

    expect(Reflect.get(weakPlanner, 'nonActionTools')).toBeUndefined()
    expect(Object.keys(Reflect.get(capablePlanner, 'nonActionTools') as NonActionToolMap).sort()).toEqual([
      'memory.read',
      'memory.search',
    ])
    expect(capable.beginMemoryTurn).toBeTypeOf('function')
    expect(capable.drainMemoryReadTraces).toBeTypeOf('function')
  })

  it('maps a production reader miss to the structured memory.read result', async () => {
    const knowledgeRoot = mkdtempSync(join(tmpdir(), 'knowledge-read-miss-'))
    try {
      const scope = { tier: 'test', key: 'checkout' } as const
      const missingId = asRecordId('record-that-no-longer-exists')
      const composition = openRunKnowledgeComposition({
        knowledgeRoot,
        product: 'shop',
        scope,
        asOfBuild: 7,
        capabilities: capabilities({ contextWindow: 32_768 }),
        accounting: {
          getCeilings: () => ({ contextWindow: 32_768, maxOutput: 4_096 }),
          estimate: () => 32,
        },
        qaRulesText: 'rules',
        workingContextText: 'checkout context',
        resolveRetrievalRung: fakeResolveRetrievalRung,
      })
      composition.beginMemoryTurn?.(scope, [missingId])

      const result = await composition.nonActionTools!['memory.read'].execute({ id: missingId })
      expect(result).toEqual({ kind: 'not-found', id: missingId })
    } finally {
      rmSync(knowledgeRoot, { recursive: true, force: true })
    }
  })
})
