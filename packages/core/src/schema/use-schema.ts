import { z } from 'zod'
import {
  BrowserConfigSchema,
  DurationString,
  TimeoutConfigSchema,
  PlannerConfigSchema,
  LogCaptureConfigSchema,
} from './primitives.js'
import { AuthStateNameSchema } from '../auth-state/schema.js'

export const MobileAppStateSchema = z.enum(['preserve', 'reset'])

export const MobileUseSchema = z.object({
  appState: MobileAppStateSchema,
}).strict()

export const MobileUseOverrideSchema = z.object({
  appState: MobileAppStateSchema.optional(),
}).strict()

export const AuthStateUseSchema = z.union([
  AuthStateNameSchema,
  z.object({
    name: AuthStateNameSchema,
    load: z.boolean().optional(),
    capture: z.boolean().optional(),
  }).strict(),
])

export interface NormalizedAuthStateUse {
  name: string
  load: boolean
  capture: boolean
}

export function normalizeAuthStateUse(
  use: { authState?: unknown } | undefined,
): NormalizedAuthStateUse | undefined {
  const parsed = AuthStateUseSchema.safeParse(use?.authState)
  if (!parsed.success) return undefined

  if (typeof parsed.data === 'string') {
    return {
      name: parsed.data,
      load: true,
      capture: false,
    }
  }

  return {
    name: parsed.data.name,
    load: parsed.data.load ?? true,
    capture: parsed.data.capture ?? false,
  }
}

export const UseSchema = z.object({
  browser: BrowserConfigSchema.optional(),
  mobile: MobileUseSchema.optional(),
  timeout: TimeoutConfigSchema.optional(),
  planner: PlannerConfigSchema.optional(),
  logCapture: LogCaptureConfigSchema.optional(),
  cache: z.boolean().optional(),
  llm: z.string().optional(),
  /**
   * Names the app-under-test build for the DCAY-01 buildTag-to-ordinal mapping.
   * Precedence: CLI --build-tag > AGENT_QA_BUILD_TAG > this config key.
   */
  buildTag: z.string().trim().min(1).optional(),
  /**
   * run the members of one run CONCURRENTLY. Absent or false is one member at a
   * time — today's behaviour, byte for byte.
   */
  parallel: z.boolean().optional(),
  /**
   * the ceiling on concurrent members when `parallel` is true. Absent resolves to
   * `DEFAULT_PARALLEL_WORKERS` (3). Effective concurrency is `min(memberCount, workers)`, decided
   * in exactly one place — `resolveEffectiveWorkers` in `@vostride/agent-qa-schema`.
   *
   * A POSITIVE INTEGER, refused otherwise: an unbounded or nonsensical count here is the only
   * reachable input to a concurrency denial-of-service, and it is a config typo rather
   * than a caller's field — `RunsStartInput` names neither of these two.
   *
   * NOT `.default(...)`: a defaulted key changes the PARSED config type and every hand-built
   * config fixture would then need it. The default is the resolver's, not the schema's.
   */
  workers: z.number().int().positive().optional(),
}).strict()

export const UseOverrideSchema = z.object({
  browser: z.object({
    name: z.enum(['chromium', 'firefox', 'webkit']).optional(),
    headless: z.boolean().optional(),
    viewport: z.object({
      width: z.number().optional(),
      height: z.number().optional(),
    }).strict().optional(),
  }).strict().optional(),
  timeout: z.object({
    step: DurationString.optional(),
    test: DurationString.optional(),
    navigation: DurationString.optional().describe(
      'How long a web page load or URL wait can take. Default 2m. Android and iOS runs do not use it.',
    ),
  }).strict().optional(),
  planner: z.object({
    maxActions: z.number().int().positive().optional(),
    maxPlanningTurns: z.number().int().positive().optional(),
    previousStepCount: z.number().optional(),
  }).strict().optional(),
  logCapture: z.object({
    console: z.boolean().optional(),
    network: z.boolean().optional(),
  }).strict().optional(),
  cache: z.boolean().optional(),
  authState: AuthStateUseSchema.optional(),
  mobile: MobileUseOverrideSchema.optional(),
  llm: z.string().optional(),
  parallel: z.boolean().optional(),
  /** the override half of `use.workers`. Same shape as `UseSchema`'s. */
  workers: z.number().int().positive().optional(),
  device: z.string().optional(),
}).strict()
