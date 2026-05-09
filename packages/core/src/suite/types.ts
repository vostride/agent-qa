import type { z } from 'zod'
import type { TestResult } from '../types/result.js'
import type { SuiteDefinitionSchema } from '../schema/suite-schema.js'

export type SuiteDefinition = z.infer<typeof SuiteDefinitionSchema>

export interface SuiteResult {
  runId?: string
  name: string
  status: 'passed' | 'failed' | 'cancelled'
  tests: TestResult[]
  duration: number
  failedAt?: number
}
