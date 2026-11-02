import { z } from 'zod'
import ms from 'ms'
import { isCanonicalHookId, isCanonicalTestId } from '@vostride/agent-qa-ids'
import { retiredStepKeyScan, retiredUseKeyScan } from './retired-keys.js'
import { UseOverrideSchema } from './use-schema.js'

const OptionalDuration = z.string()
  .refine((v) => ms(v as ms.StringValue) !== undefined, {
    error: 'Invalid duration format (e.g., "30s", "5m", "1h")',
  })
  .transform((v) => ms(v as ms.StringValue) as number)
  .optional()

export const CaptureConfigSchema = z.strictObject({
  variable: z.string(),
  method: z.enum(['regex', 'selector', 'ai']),
  pattern: z.string().optional(),
  selector: z.string().optional(),
  description: z.string().optional(),
})

export const TestStepSchema = z.union([
  z.string(),
  z.strictObject({
    step: z.string(),
    timeout: OptionalDuration,
    capture: CaptureConfigSchema.optional(),
  }),
])

export const TestMetaSchema = z.strictObject({
  timeout: OptionalDuration,
  retries: z.number().optional(),
  record: z.boolean().optional(),
})

const HookIdSchema = z.string().refine((value) => isCanonicalHookId(value), {
  error: 'Hook ID must be h_ followed by 10 id-agent words',
})

export const TestDefinitionSchema = z.strictObject({
  'test-id': z.string().refine((value) => isCanonicalTestId(value), {
    error: 'Test ID must be t_ followed by 10 id-agent words',
  }),
  name: z.string(),
  target: z.string(),
  context: z.string().optional(),
  use: retiredUseKeyScan.pipe(UseOverrideSchema).optional(),
  meta: TestMetaSchema.optional(),
  setup: z.array(HookIdSchema).optional(),
  teardown: z.array(HookIdSchema).optional(),
  steps: z.array(retiredStepKeyScan.pipe(TestStepSchema)).min(1),
})
