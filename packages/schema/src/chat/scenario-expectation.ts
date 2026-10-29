// Two expectations and no confidence member: stage-1 resolution is binary, and a turn is atomic.

import { z } from 'zod'

import { CHAT_SESSION_EVENT_KINDS } from './session-events'

export const SCENARIO_EXPECTATIONS = ['should_execute', 'fail_closed'] as const

export type ScenarioExpectationKind = (typeof SCENARIO_EXPECTATIONS)[number]

// `deterministic` scenarios never touch the model, so they need no mock.
export const SCENARIO_CLASSES = ['deterministic', 'planner', 'compound'] as const

export type ScenarioClass = (typeof SCENARIO_CLASSES)[number]

/** Where a scenario runs. `hermetic` is per-commit CI; `live` is the release gate. */
export const SCENARIO_LANES = ['hermetic', 'live'] as const

export type ScenarioLane = (typeof SCENARIO_LANES)[number]

// `executed` is required on both arms, so a fail-closed scenario cannot stay silent about it.
export const ScenarioExpectationSchema = z.object({
  kind: z.enum(SCENARIO_EXPECTATIONS),
  planned: z.number().int().nonnegative().optional(),
  executed: z.number().int().nonnegative(),
  ops: z.array(z.string()).optional(),
  argsPin: z.record(z.string(), z.unknown()).optional(),
  namesClause: z.string().optional(),
  // A directive invokes nothing, so the event it leaves is the only proof it ran.
  emitsSessionEvent: z.enum(CHAT_SESSION_EVENT_KINDS).optional(),
  // `/help` and `/quit` leave no event, so a fragment of the answer is their only proof.
  answerContains: z.string().optional(),
})

export const ChatScenarioSchema = z.object({
  id: z.string().min(1),
  class: z.enum(SCENARIO_CLASSES),
  lane: z.enum(SCENARIO_LANES),
  utterance: z.string().min(1),
  expect: ScenarioExpectationSchema,
})

export type ScenarioExpectation = z.infer<typeof ScenarioExpectationSchema>
export type ChatScenario = z.infer<typeof ChatScenarioSchema>
