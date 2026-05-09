import { z } from 'zod'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export type LogSource = 'agent' | 'adapter' | 'cache' | 'planner' | 'healer' | 'hook' | 'runner'

export interface LogEntry {
  id: string
  stepId: string | null
  runId: string
  level: Exclude<LogLevel, 'silent'>
  source: LogSource
  message: string
  data: Record<string, unknown>
  timestamp: string
}

export interface LogStorage {
  insertLogs(entries: LogEntry[]): void
  getLogs(opts: {
    runId?: string
    stepId?: string
    level?: string
    source?: string
    limit?: number
    offset?: number
  }): LogEntry[]
}

export interface ScopedLogger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

// Per-source Zod data schemas
export const AgentLogDataSchema = z.object({
  extractDom: z.boolean().optional(),
  hasScreenshot: z.boolean().optional(),
  duration: z.number().optional(),
  elementCount: z.number().optional(),
})

export const AdapterLogDataSchema = z.object({
  actionType: z.string().optional(),
  selector: z.string().optional(),
  coordinates: z.object({ x: z.number(), y: z.number() }).optional(),
  elementProperties: z.record(z.string(), z.unknown()).optional(),
  duration: z.number().optional(),
})

export const CacheLogDataSchema = z.object({
  operation: z.enum(['get', 'set', 'invalidate', 'bypass', 'batch-purge']),
  stepHash: z.string().optional(),
  screenHash: z.string().optional(),
  hit: z.boolean().optional(),
  age: z.number().optional(),
  entriesDeleted: z.number().optional(),
})

export const PlannerLogDataSchema = z.object({
  model: z.string().optional(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  latencyMs: z.number().optional(),
  confidence: z.number().optional(),
  actionType: z.string().optional(),
})

export const HealerLogDataSchema = z.object({
  strategy: z.string().optional(),
  attempt: z.number().optional(),
  maxAttempts: z.number().optional(),
  stateDiffDetected: z.boolean().optional(),
  success: z.boolean().optional(),
})

export const HookLogDataSchema = z.object({
  hookName: z.string().optional(),
  phase: z.enum(['setup', 'teardown']).optional(),
  duration: z.number().optional(),
  success: z.boolean().optional(),
})

export const RunnerLogDataSchema = z.object({
  stepIndex: z.number().optional(),
  totalSteps: z.number().optional(),
  testName: z.string().optional(),
  variablesCaptured: z.number().optional(),
})

export const LogSourceDataSchemas: Record<LogSource, z.ZodType> = {
  agent: AgentLogDataSchema,
  adapter: AdapterLogDataSchema,
  cache: CacheLogDataSchema,
  planner: PlannerLogDataSchema,
  healer: HealerLogDataSchema,
  hook: HookLogDataSchema,
  runner: RunnerLogDataSchema,
}
