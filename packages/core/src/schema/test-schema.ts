import { z } from 'zod'
import ms from 'ms'
import { isCanonicalHookId, isCanonicalTestId } from '@vostride/agent-qa-ids'
import { UseOverrideSchema } from './use-schema.js'

const OptionalDuration = z.string()
  .refine((v) => ms(v as ms.StringValue) !== undefined, {
    message: 'Invalid duration format (e.g., "30s", "5m", "1h")',
  })
  .transform((v) => ms(v as ms.StringValue) as number)
  .optional()

export const CaptureConfigSchema = z.object({
  variable: z.string(),
  method: z.enum(['regex', 'selector', 'ai']),
  pattern: z.string().optional(),
  selector: z.string().optional(),
  description: z.string().optional(),
}).strict()

export const TestStepSchema = z.union([
  z.string(),
  z.object({
    step: z.string(),
    timeout: OptionalDuration,
    retries: z.number().optional(),
    screenshot: z.boolean().optional(),
    capture: CaptureConfigSchema.optional(),
    maxAttempts: z.number().optional(),
  }).strict(),
])

export const TestMetaSchema = z.object({
  timeout: OptionalDuration,
  retries: z.number().optional(),
  record: z.boolean().optional(),
}).strict()

const HookIdSchema = z.string().refine((value) => isCanonicalHookId(value), {
  message: 'Hook ID must be h_ followed by 10 id-agent words',
})

export const TestDefinitionSchema = z.object({
  'test-id': z.string().refine((value) => isCanonicalTestId(value), {
    message: 'Test ID must be t_ followed by 10 id-agent words',
  }),
  name: z.string(),
  target: z.string(),
  context: z.string().optional(),
  use: UseOverrideSchema.optional(),
  meta: TestMetaSchema.optional(),
  setup: z.array(HookIdSchema).optional(),
  teardown: z.array(HookIdSchema).optional(),
  steps: z.array(TestStepSchema).min(1),
}).strict()
