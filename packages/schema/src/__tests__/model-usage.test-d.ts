import { expectTypeOf, test } from 'vitest'
import { MODEL_USAGE_ROLES, ModelUsageRoleSchema } from '../index'
import type { ModelUsage, ModelUsageRole, ModelUsageObservations } from '../index'
import type { ModelTokenUsage, RunDetailStep, StepFinalizedPayload, RunStepTokenUsage } from '../index'
import type { z } from 'zod'

test('C423-MODEL-ROLES-EXACT: type roles are literally planner and verifier', () => {
  type Expected = 'planner' | 'verifier'
  expectTypeOf<ModelUsageRole>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof MODEL_USAGE_ROLES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<z.infer<typeof ModelUsageRoleSchema>>().toEqualTypeOf<Expected>()
  expectTypeOf<keyof ModelUsage['roles']>().toEqualTypeOf<Expected>()
  expectTypeOf<ModelUsageObservations['attempts'][number]['role']>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ModelUsageRole, (typeof MODEL_USAGE_ROLES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof MODEL_USAGE_ROLES)[number], ModelUsageRole>>().toEqualTypeOf<never>()
})

test('MODEL-USAGE-OPTIONAL: bus and persisted step share the schema-owned optional contracts', () => {
  expectTypeOf<StepFinalizedPayload['modelUsage']>().toEqualTypeOf<ModelUsage | undefined>()
  expectTypeOf<RunDetailStep['modelUsage']>().toEqualTypeOf<ModelUsage | undefined>()
  expectTypeOf<StepFinalizedPayload['tokenUsage']>().toEqualTypeOf<ModelTokenUsage | undefined>()
  expectTypeOf<RunStepTokenUsage>().toEqualTypeOf<ModelTokenUsage>()
  expectTypeOf<RunDetailStep['tokenUsage']>().toEqualTypeOf<ModelTokenUsage | undefined>()
})

// 2026-09-15, 423-25: the remaining introduced arms, spelled by hand. Cache creation stays out of
// the contract by explicit phase exclusion, so its absence is pinned too.
test('C423-MODEL-USAGE-ARMS-EXACT: call counters, attempt kinds and reported fields are exactly the recorded arms', () => {
  type Attempt = ModelUsageObservations['attempts'][number]
  expectTypeOf<keyof ModelUsage>().toEqualTypeOf<'roles' | 'calls' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>()
  expectTypeOf<keyof ModelUsage['calls']>().toEqualTypeOf<'started' | 'succeeded' | 'failed'>()
  expectTypeOf<Attempt['kind']>().toEqualTypeOf<'start' | 'success' | 'failure'>()
  expectTypeOf<keyof NonNullable<Attempt['report']>>()
    .toEqualTypeOf<'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'respondingModelId'>()
  expectTypeOf<keyof ModelTokenUsage>().toEqualTypeOf<'promptTokens' | 'completionTokens' | 'totalTokens' | 'cachedInputTokens'>()
  expectTypeOf<Extract<keyof ModelUsage | keyof ModelTokenUsage, `cacheCreation${string}`>>().toEqualTypeOf<never>()
})
