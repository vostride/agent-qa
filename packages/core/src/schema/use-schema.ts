import { z } from 'zod'
import {
  BrowserConfigSchema,
  DurationString,
  TimeoutConfigSchema,
  PlannerConfigSchema,
  LogCaptureConfigSchema,
  NameSlugSchema,
} from './primitives.js'
import { AuthStateNameSchema } from '../auth-state/schema.js'

export const MobileAppStateSchema = z.enum(['preserve', 'reset'])

export const MobileUseSchema = z.strictObject({
  appState: MobileAppStateSchema,
})

export const MobileUseOverrideSchema = z.strictObject({
  appState: MobileAppStateSchema.optional(),
})

export const AuthStateUseSchema = z.union([
  AuthStateNameSchema,
  z.strictObject({
    name: AuthStateNameSchema,
    load: z.boolean().optional(),
    capture: z.boolean().optional(),
  }),
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

export const UseSchema = z.strictObject({
  browser: BrowserConfigSchema.optional(),
  mobile: MobileUseSchema.optional(),
  timeout: TimeoutConfigSchema.optional(),
  planner: PlannerConfigSchema.optional(),
  logCapture: LogCaptureConfigSchema.optional(),
  cache: z.boolean().optional(),
  llm: z.string().optional(),
  // Precedence: CLI `--build-tag`, then `AGENT_QA_BUILD_TAG`, then this key.
  buildTag: z.string().trim().min(1).optional(),
  // Runs one run's members concurrently; absent or false runs one member at a time.
  parallel: z.boolean().optional(),
  // Not defaulted, so the parsed type is unchanged; `resolveEffectiveWorkers` owns the default.
  workers: z.number().int().positive().optional(),
})

export const UseOverrideSchema = z.strictObject({
  browser: z.strictObject({
    name: z.enum(['chromium', 'firefox', 'webkit']).optional(),
    headless: z.boolean().optional(),
    viewport: z.strictObject({
      width: z.number().optional(),
      height: z.number().optional(),
    }).optional(),
    remote: NameSlugSchema.optional(),
  }).optional(),
  timeout: z.strictObject({
    step: DurationString.optional(),
    test: DurationString.optional(),
    navigation: DurationString.optional().describe(
      'How long a web page load or URL wait can take. Default 2m. Android and iOS runs do not use it.',
    ),
  }).optional(),
  planner: z.strictObject({
    maxActions: z.number().int().positive().optional(),
    maxPlanningTurns: z.number().int().positive().optional(),
    previousStepCount: z.number().optional(),
  }).optional(),
  logCapture: z.strictObject({
    console: z.boolean().optional(),
    network: z.boolean().optional(),
  }).optional(),
  cache: z.boolean().optional(),
  authState: AuthStateUseSchema.optional(),
  mobile: MobileUseOverrideSchema.optional(),
  llm: z.string().optional(),
  parallel: z.boolean().optional(),
  // The override half of `use.workers`, shaped like `UseSchema`'s.
  workers: z.number().int().positive().optional(),
  device: z.string().optional(),
})
