import { z } from 'zod'
import { isCanonicalHookId, isCanonicalSuiteId, isCanonicalTestId } from '@vostride/agent-qa-ids'
import { retiredUseKeyScan } from './retired-keys.js'
import { UseOverrideSchema } from './use-schema.js'

export const SuiteTestEntrySchema = z.strictObject({
  test: z.string(),
  id: z.string().refine((value) => isCanonicalTestId(value), {
    error: 'Test ID must be t_ followed by 10 id-agent words',
  }),
})

const HookIdSchema = z.string().refine((value) => isCanonicalHookId(value), {
  error: 'Hook ID must be h_ followed by 10 id-agent words',
})

export const SuiteDefinitionSchema = z.strictObject({
  'suite-id': z.string().refine((value) => isCanonicalSuiteId(value), {
    error: 'Suite ID must be s_ followed by 10 id-agent words',
  }).optional(),
  name: z.string(),
  target: z.string(),
  context: z.string().optional(),
  setup: z.array(HookIdSchema).optional(),
  teardown: z.array(HookIdSchema).optional(),
  tests: z.array(SuiteTestEntrySchema).min(1),
  use: retiredUseKeyScan.pipe(UseOverrideSchema).optional(),
})
