import { describe, it, expect } from 'vitest'
import {
  AgentLogDataSchema,
  AdapterLogDataSchema,
  CacheLogDataSchema,
  PlannerLogDataSchema,
  HealerLogDataSchema,
  HookLogDataSchema,
  RunnerLogDataSchema,
  LogSourceDataSchemas,
} from '../logging/types.js'
import { LoggingConfigSchema } from '../schema/services-schema.js'

describe('Per-source Zod data schemas', () => {
  it('AgentLogDataSchema validates correct shape', () => {
    const result = AgentLogDataSchema.safeParse({
      extractDom: true,
      hasScreenshot: false,
      duration: 150,
      elementCount: 42,
    })
    expect(result.success).toBe(true)
  })

  it('AgentLogDataSchema accepts empty object (all optional)', () => {
    expect(AgentLogDataSchema.safeParse({}).success).toBe(true)
  })

  it('AdapterLogDataSchema validates correct shape', () => {
    const result = AdapterLogDataSchema.safeParse({
      actionType: 'click',
      selector: '#submit',
      coordinates: { x: 100, y: 200 },
      duration: 50,
    })
    expect(result.success).toBe(true)
  })

  it('CacheLogDataSchema validates correct shape', () => {
    const result = CacheLogDataSchema.safeParse({
      operation: 'get',
      stepHash: 'abc123',
      hit: true,
      age: 5000,
    })
    expect(result.success).toBe(true)
  })

  it('CacheLogDataSchema requires operation field', () => {
    const result = CacheLogDataSchema.safeParse({ hit: true })
    expect(result.success).toBe(false)
  })

  it('PlannerLogDataSchema validates correct shape', () => {
    const result = PlannerLogDataSchema.safeParse({
      model: 'claude-sonnet-4-20250514',
      promptTokens: 1500,
      completionTokens: 200,
      latencyMs: 2500,
      confidence: 0.95,
      actionType: 'click',
    })
    expect(result.success).toBe(true)
  })

  it('HealerLogDataSchema validates correct shape', () => {
    const result = HealerLogDataSchema.safeParse({
      strategy: 'two-tier',
      attempt: 1,
      maxAttempts: 3,
      stateDiffDetected: true,
      success: false,
    })
    expect(result.success).toBe(true)
  })

  it('HookLogDataSchema validates correct shape', () => {
    const result = HookLogDataSchema.safeParse({
      hookName: 'setup-db',
      phase: 'setup',
      duration: 1200,
      success: true,
    })
    expect(result.success).toBe(true)
  })

  it('RunnerLogDataSchema validates correct shape', () => {
    const result = RunnerLogDataSchema.safeParse({
      stepIndex: 3,
      totalSteps: 10,
      testName: 'login test',
      variablesCaptured: 2,
    })
    expect(result.success).toBe(true)
  })

  it('LogSourceDataSchemas has all 7 sources', () => {
    const sources = ['agent', 'adapter', 'cache', 'planner', 'healer', 'hook', 'runner']
    for (const source of sources) {
      expect(LogSourceDataSchemas).toHaveProperty(source)
    }
  })
})

describe('LoggingConfigSchema', () => {
  it('requires level field', () => {
    const result = LoggingConfigSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('accepts valid level values', () => {
    for (const level of ['silent', 'error', 'warn', 'info', 'debug']) {
      const result = LoggingConfigSchema.safeParse({ level })
      expect(result.success).toBe(true)
    }
  })

  it('rejects invalid level values', () => {
    const result = LoggingConfigSchema.safeParse({ level: 'trace' })
    expect(result.success).toBe(false)
    const result2 = LoggingConfigSchema.safeParse({ level: 'verbose' })
    expect(result2.success).toBe(false)
  })
})
