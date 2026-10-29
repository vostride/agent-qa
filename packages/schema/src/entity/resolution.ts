// Two unions so the store layer has no card vocabulary and the function layer is the one producer.

import { z } from 'zod'

import { EntityCardSchema } from './entity-card'
import { ENTITY_KINDS } from './kinds'
import { EntityUriSchema } from './uri'

// Small on purpose: a long list hands the never-guess decision back to a person.
export const ENTITY_RESOLUTION_MAX_CANDIDATES = 3

/** The score tier (a) answers with: an address that parsed and matched is not a guess. */
export const ENTITY_EXACT_MATCH_SCORE = 1

/**
 * Why a reference resolved to nothing. A bare `none` would have collapsed two genuinely
 * different situations — a well-formed address for an entity that was never minted, and text
 * that matched no addressing rule at all — into one answer, and a surface cannot phrase a
 * useful message without knowing which one it holds.
 */
export const ENTITY_NO_MATCH_REASONS = [
  'unknown-address',
  'no-match',
] as const

export type EntityNoMatchReason = (typeof ENTITY_NO_MATCH_REASONS)[number]

// `statusSource` is a plain string: the producer's schema refuses an unknown status, never maps it.
export const EntityDescriptorSchema = z.object({
  kind: z.enum(ENTITY_KINDS),
  shortId: z.string().min(1),
  uri: EntityUriSchema,
  machineId: z.string().min(1),
  title: z.string(),
  statusSource: z.string().min(1),
  // Only a recorded rename sets this; a card shows it rather than redirecting an old reference.
  successorMachineId: z.string().min(1).optional(),
  // Reported beside `machineId`, never parsed from it; absent when the store cannot say.
  testIdentity: z.object({
    product: z.string().min(1),
    filePath: z.string().min(1),
    testName: z.string().min(1),
  }).strict().optional(),
}).strict()

export type EntityDescriptor = z.infer<typeof EntityDescriptorSchema>

const scoreSchema = z.number().min(0).max(1)

const noneArm = z.object({
  kind: z.literal('none'),
  reason: z.enum(ENTITY_NO_MATCH_REASONS),
  /** The nearest address worth offering, when one exists. Never auto-applied. */
  closestSuggestion: z.string().min(1).optional(),
}).strict()

export const EntityResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resolved'),
    descriptor: EntityDescriptorSchema,
    score: scoreSchema,
  }).strict(),
  z.object({
    kind: z.literal('ambiguous'),
    candidates: z.array(
      z.object({ descriptor: EntityDescriptorSchema, score: scoreSchema }).strict(),
    ).min(2).max(ENTITY_RESOLUTION_MAX_CANDIDATES),
  }).strict(),
  noneArm,
])

export type EntityResolution = z.infer<typeof EntityResolutionSchema>

export const EntityCardResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resolved'),
    card: EntityCardSchema,
    score: scoreSchema,
  }).strict(),
  z.object({
    kind: z.literal('ambiguous'),
    candidates: z.array(
      z.object({ card: EntityCardSchema, score: scoreSchema }).strict(),
    ).min(2).max(ENTITY_RESOLUTION_MAX_CANDIDATES),
  }).strict(),
  noneArm,
])

export type EntityCardResolution = z.infer<typeof EntityCardResolutionSchema>

/** `entities.resolve` input: any reference at all — short-ID, URI, or free text. */
export const EntitiesResolveInputSchema = z.object({
  ref: z.string().min(1),
}).strict()

export type EntitiesResolveInput = z.infer<typeof EntitiesResolveInputSchema>

// `entities.get` takes an exact address.
export const EntitiesGetInputSchema = z.object({
  ref: z.string().min(1),
}).strict()

export type EntitiesGetInput = z.infer<typeof EntitiesGetInputSchema>
