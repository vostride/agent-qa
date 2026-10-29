import { expect, test } from 'vitest'
import { asRunId, RunDetailProjectionSchema, RunDetailStepSchema } from '@vostride/agent-qa-schema'
import type { ModelUsage, RunDetailStep, RunStepTokenUsage } from '@vostride/agent-qa-schema'
import { projectRunTokenTotals, projectRunModelSummary, runsDetailSpec } from '../ops/runs-detail.js'
import type { FunctionDeps } from '../spec.js'

function step(stepIndex: number, tokenUsage?: RunStepTokenUsage, modelUsage?: ModelUsage) {
  return { testIndex: 0, stepIndex, cacheStatus: 'hit' as const,
    verifierVerdict: { pass: true, reasoning: 'ok' }, selfHealOccurred: false, briefDigest: 'digest',
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(modelUsage === undefined ? {} : { modelUsage }),
  }
}
function tokens(input: number, output: number, cached?: number) {
  return { promptTokens: input, completionTokens: output, totalTokens: input + output,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }) }
}
const model: ModelUsage = { calls: { started: 3, succeeded: 3, failed: 0 }, roles: {
  planner: { declared: { provider: 'provider-[secret]', modelId: 'alias-[secret]' },
    respondingModelIds: ['response-[secret]', 'response-[secret]'] },
  verifier: { declared: { provider: 'provider-[secret]', modelId: 'alias-[secret]' },
    respondingModelIds: ['response-[secret]'] },
} }
async function read(steps: RunDetailStep[]) {
  const runId = asRunId('usage-contract')
  return runsDetailSpec.invoke({ runId }, { runDetail: {
    read: async () => ({ runId, members: [], steps, subActions: [] }),
  } } as unknown as FunctionDeps)
}

test('TOTALS-MIXED-COVERAGE: cache sums and denominator use exactly cache-measured steps', () => {
  const rows = [step(0, tokens(100, 7, 60)), step(1, tokens(900, 13)),
    step(2, tokens(200, 11, 0)), step(3)]
  expect(projectRunTokenTotals(rows)).toEqual({ measuredSteps: 3, unmeasuredSteps: 1,
    promptTokens: 1200, completionTokens: 31, totalTokens: 1231,
    cachedInputTokens: 60, cachedMeasuredSteps: 2, cachedInputMeasuredTokens: 300 })
})

test('TOTALS-REPORTED-ZERO: explicit zero survives, execution hits never create coverage', () => {
  expect(projectRunTokenTotals([step(0, tokens(0, 0, 0))])).toEqual({
    measuredSteps: 1, unmeasuredSteps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    cachedInputTokens: 0, cachedMeasuredSteps: 1, cachedInputMeasuredTokens: 0,
  })
  expect(projectRunTokenTotals([step(0), step(1, tokens(10, 2))])).toEqual({
    measuredSteps: 1, unmeasuredSteps: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12,
  })
})

test('MODEL-MIXED-STEPS: duplicate calls and roles count each step once per identity', async () => {
  const other: ModelUsage = { calls: { started: 1, succeeded: 1, failed: 0 }, roles: {
    planner: { declared: { provider: 'provider-[secret]', modelId: 'second' },
      respondingModelIds: ['response-[secret]', 'second-response'] },
  } }
  const result = await read([step(0, undefined, model), step(1, undefined, model),
    step(2, undefined, other), step(3)])
  expect(result).toHaveProperty('models', {
    declared: [{ provider: 'provider-[secret]', modelId: 'alias-[secret]', stepCount: 2 },
      { provider: 'provider-[secret]', modelId: 'second', stepCount: 1 }],
    responding: [{ provider: 'provider-[secret]', modelId: 'response-[secret]', stepCount: 3 },
      { provider: 'provider-[secret]', modelId: 'second-response', stepCount: 1 }],
  })
  expect(RunDetailProjectionSchema.safeParse(result).success).toBe(true)
})

test('HISTORICAL-USAGE-ABSENT: persisted old DTOs keep optional identity and cache fields absent', async () => {
  const old = RunDetailStepSchema.parse(JSON.parse(JSON.stringify(step(0, tokens(9, 2)))))
  expect(old).not.toHaveProperty('modelUsage')
  expect(old.tokenUsage).not.toHaveProperty('cachedInputTokens')
  const result = await read([old, step(1)])
  expect(result).not.toHaveProperty('models')
  expect(result.tokens).not.toHaveProperty('cachedInputTokens')
  expect(RunDetailProjectionSchema.safeParse(result).success).toBe(true)
})

test('HISTORICAL-USAGE-ABSENT: persisted new DTO accepts exact usage and rejects unknown fields', () => {
  const row = JSON.parse(JSON.stringify(step(0, tokens(100, 3, 0), model)))
  const parsed = RunDetailStepSchema.safeParse(row)
  expect(parsed.success).toBe(true)
  if (!parsed.success) return
  expect(parsed.data).toEqual(row)
  expect(RunDetailStepSchema.safeParse({ ...row, modelUsage: { ...model,
    roles: { ...model.roles, healer: {} } } }).success).toBe(false)
  expect(RunDetailStepSchema.safeParse({ ...row, tokenUsage: {
    ...row.tokenUsage, cacheWriteTokens: 4 } }).success).toBe(false)
})

test('MODEL-MIXED-STEPS: unique member-step keys and provider identity prevent conflation', () => {
  const first = step(0, undefined, model)
  const second = { ...first, testIndex: 1 }
  const third = step(2, undefined, { calls: { started: 0, succeeded: 0, failed: 0 },
    roles: { planner: { declared: { provider: 'another', modelId: 'alias-[secret]' } } } })
  expect(projectRunModelSummary([first, first, second, third])).toEqual({
    declared: [{ provider: 'provider-[secret]', modelId: 'alias-[secret]', stepCount: 2 },
      { provider: 'another', modelId: 'alias-[secret]', stepCount: 1 }],
    responding: [{ provider: 'provider-[secret]', modelId: 'response-[secret]', stepCount: 2 }],
  })
})

test('HISTORICAL-USAGE-ABSENT: unknown identities stay absent despite measured calls', () => {
  expect(projectRunModelSummary([step(0, tokens(0, 0, 0), {
    calls: { started: 1, succeeded: 1, failed: 0 }, roles: {},
  })])).toBeUndefined()
  expect(projectRunTokenTotals([step(0), step(1)])).toEqual({ measuredSteps: 0, unmeasuredSteps: 2 })
  expect(projectRunModelSummary([step(0, undefined, {
    calls: { started: 1, succeeded: 1, failed: 0 },
    roles: { verifier: { respondingModelIds: ['reported-only'] } },
  })])).toEqual({ responding: [{ modelId: 'reported-only', stepCount: 1 }] })
})

test('MODEL-MIXED-STEPS: the op uses the pure folds and preserves persisted inputs', async () => {
  const rows = [step(0, tokens(80, 9, 0), model), step(1)]
  const before = JSON.stringify(rows)
  const result = await read(rows)
  expect(result.models).toEqual(projectRunModelSummary(rows))
  expect(result.tokens).toEqual(projectRunTokenTotals(rows))
  expect(JSON.stringify(rows)).toBe(before)
  expect(RunDetailProjectionSchema.parse(result)).toEqual(result)
})
