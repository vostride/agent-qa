import { z } from 'zod'
import {
  BrowserConfigSchema,
  DurationString,
  TimeoutConfigSchema,
  HealingConfigSchema,
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
  healing: HealingConfigSchema.optional(),
  planner: PlannerConfigSchema.optional(),
  logCapture: LogCaptureConfigSchema.optional(),
  cache: z.boolean().optional(),
  llm: z.string().optional(),
  parallel: z.boolean().optional(),
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
    navigation: DurationString.optional(),
  }).strict().optional(),
  healing: z.object({
    maxAttempts: z.number().optional(),
  }).strict().optional(),
  planner: z.object({
    maxSubActions: z.number().optional(),
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
  device: z.string().optional(),
}).strict()
