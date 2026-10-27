import { z } from 'zod'

import type { BrowserConfig } from './browser'
import { appStateSchema, browserConfigSchema } from './browser'

/**
 * useSchema validates authored test/suite overrides and intentionally requires
 * platform so web/android/ios arms can reject wrong-platform keys structurally.
 * The residual rule that disallows use.platform at the global config tier
 * belongs on the future global-config wrapper; Phase 312 has no such wrapper,
 * so that tier rule is deferred to the consumer-migration milestone.
 */

export type UseWebAuthState = string | {
  name: string
  load?: boolean
  capture?: boolean
}

/**
 * 402-03 (D-12): member concurrency, as a CONFIG author writes it.
 *
 * `parallel` absent or false means one member at a time — today's behaviour, byte for byte.
 * `workers` is the ceiling a config owner tunes; absent means `DEFAULT_PARALLEL_WORKERS`.
 *
 * IT IS DELIBERATELY NOT AN ARM-SPECIFIC FIELD. Concurrency is a property of the RUN, not of the
 * platform it drives, so the two fields repeat identically on all three arms rather than belonging
 * to one — which is also why they are declared here, above the arms, instead of inside the web arm
 * where a web-only knob would live.
 *
 * NO ZOD `.default()`, on purpose: a defaulted field changes the PARSED type and every hand-built
 * config fixture in the workspace then needs the key. The default lives in
 * `resolveEffectiveWorkers`, which is the one place a worker COUNT is ever decided.
 */
export interface UseConcurrency {
  parallel?: boolean
  workers?: number
}

export interface UseWeb extends UseConcurrency {
  platform: 'web'
  browser?: BrowserConfig
  authState?: UseWebAuthState
}

export interface UseAndroid extends UseConcurrency {
  platform: 'android'
  device?: string
  appState?: 'preserve' | 'reset'
}

export interface UseIos extends UseConcurrency {
  platform: 'ios'
  device?: string
  appState?: 'preserve' | 'reset'
}

export type Use = UseWeb | UseAndroid | UseIos

const useWebAuthStateSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    load: z.boolean().optional(),
    capture: z.boolean().optional(),
  }).strict(),
])

/** The two concurrency fields, spelled ONCE and spread into every arm (D-12). */
const useConcurrencyShape = {
  parallel: z.boolean().optional(),
  workers: z.number().int().positive().optional(),
} as const

const useWebArm = z.object({
  platform: z.literal('web'),
  browser: browserConfigSchema.optional(),
  authState: useWebAuthStateSchema.optional(),
  ...useConcurrencyShape,
}).strict()

const useAndroidArm = z.object({
  platform: z.literal('android'),
  device: z.string().optional(),
  appState: appStateSchema.optional(),
  ...useConcurrencyShape,
}).strict()

const useIosArm = z.object({
  platform: z.literal('ios'),
  device: z.string().optional(),
  appState: appStateSchema.optional(),
  ...useConcurrencyShape,
}).strict()

export const useSchema = z.discriminatedUnion('platform', [useWebArm, useAndroidArm, useIosArm])

/**
 * The conservative ceiling a `use.parallel: true` with no explicit count resolves to (402-03).
 *
 * THREE, not "as many as there are members": every concurrent member owns a browser or a device
 * session, and RESEARCH Pitfall 11 is the memory/handle exhaustion that follows from letting a
 * run's member count decide how much of the machine it takes. A config owner who wants more says
 * so with `use.workers`.
 */
export const DEFAULT_PARALLEL_WORKERS = 3

/** What the one formula reads: the config's two fields, and how many members this run has. */
export interface EffectiveWorkersInput {
  /** `use.parallel` — absent or false means sequential. */
  readonly parallel?: boolean | undefined
  /** `use.workers` — absent means `DEFAULT_PARALLEL_WORKERS`. */
  readonly workers?: number | undefined
  /** How many members this run assembled. */
  readonly memberCount: number
}

/**
 * THE ONE PLACE A WORKER COUNT IS DECIDED (402-03, D-12).
 *
 * `min(memberCount, workers ?? DEFAULT_PARALLEL_WORKERS)` when `parallel` is true, and 1 otherwise
 * — never below 1, so a zero-member run still resolves to the sequential shape the shell defaults
 * to. Both doors (`agent-qa run` and the service's `runs.start`) reach the pool through this
 * function; there is no second spelling of the default, and none of its inputs can come from a
 * request (`RunsStartInput` names neither field — pinned in `runs-start-input-posture.test.ts`).
 *
 * A WORKERS VALUE THE SCHEMA WOULD HAVE REFUSED resolves to the default rather than to something
 * unbounded — zero, negative, fractional-below-one and non-finite counts are all "not a count", and
 * the honest answer to "not a count" is the same conservative ceiling an absent one gets (T-402-12).
 */
export function resolveEffectiveWorkers(input: EffectiveWorkersInput): number {
  if (input.parallel !== true) return 1
  const requested = input.workers === undefined ? DEFAULT_PARALLEL_WORKERS : Math.floor(input.workers)
  const ceiling = Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_PARALLEL_WORKERS
  return Math.max(1, Math.min(input.memberCount, ceiling))
}
