import type { z } from 'zod'
import type {
  TestDefinitionSchema,
  TestStepSchema,
  TestMetaSchema,
  CaptureConfigSchema,
} from '../schema/test-schema.js'
import type { UseOverrideSchema } from '../schema/use-schema.js'

export type TestStep = z.infer<typeof TestStepSchema>
export type TestMeta = z.infer<typeof TestMetaSchema>
export type TestConfig = z.infer<typeof UseOverrideSchema>
export type TestDefinition = z.infer<typeof TestDefinitionSchema>
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>
