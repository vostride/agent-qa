import { z } from 'zod'

import { sha256hex } from '../determinism/sha256'
import { asRecordId } from '../ids/record-id'
import { computeBriefDigest } from './compute-brief-digest'
import type { LosslessServedBriefProofV1, ServedBrief } from './served-brief'

export const SERVED_BRIEF_PROOF_SCHEMA_VERSION = 2

export type LosslessServedBrief = ServedBrief & {
  proof: LosslessServedBriefProofV1
}

const finiteNumberSchema = z.number()
const nonnegativeIntegerSchema = finiteNumberSchema.int().nonnegative()
const nonemptyStringSchema = z.string().min(1)
const digestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'expected a lowercase SHA-256 hex digest')
const recordIdSchema = nonemptyStringSchema.transform(asRecordId)

const scopeKeySchema = z
  .object({
    tier: z.enum(['global', 'product', 'suite', 'test']),
    key: nonemptyStringSchema,
  })
  .strict()

const anchorSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('page'), route: z.string() }).strict(),
  z.object({ t: z.literal('flow'), name: z.string() }).strict(),
  z
    .object({
      t: z.literal('el'),
      role: z.string(),
      name: z.string(),
      ordinal: nonnegativeIntegerSchema.optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('platform'),
      platform: z.enum(['web', 'android', 'ios']),
    })
    .strict(),
  z.object({ t: z.literal('selector'), literal: z.string() }).strict(),
  z.object({ t: z.literal('error'), message: z.string() }).strict(),
])

export const BriefLineSchema = z
  .object({
    id: recordIdSchema,
    kind: z.string(),
    summary: z.string(),
    trust: finiteNumberSchema.nonnegative(),
    status: z.string(),
    servedAsCanary: z.boolean(),
    tier: z.string(),
  })
  .strict()

const readTraceSchema = z
  .object({
    id: recordIdSchema,
    detailLevel: z.string(),
    bodyDigest: z.string(),
  })
  .strict()

const cautionLineSchema = z
  .object({
    id: recordIdSchema,
    anchors: z.array(anchorSchema),
    summary: z.string(),
  })
  .strict()

const servedAdmissionEventSchema = z
  .object({
    ordinal: nonnegativeIntegerSchema,
    turnOrdinal: nonnegativeIntegerSchema,
    surface: z.enum([
      'brief-line',
      'search-result',
      'read-body',
      'caution',
      'procedure-hint',
    ]),
    id: recordIdSchema,
    sourceId: nonemptyStringSchema,
    clusterKey: nonemptyStringSchema,
    renderedCost: nonnegativeIntegerSchema,
    chargeRepeated: z.boolean(),
  })
  .strict()

const runDateSchema = z
  .string()
  .regex(
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
    'expected a YYYY-MM-DD UTC date',
  )

const servedPromptTurnSchema = z
  .object({
    ordinal: nonnegativeIntegerSchema,
    turnOrdinal: nonnegativeIntegerSchema,
    runDate: runDateSchema,
    policyL0: z.string(),
    learnedL1: z.string(),
    learnedL2: z.string(),
    contextTier: nonemptyStringSchema,
    volatileTier: nonemptyStringSchema,
    policyDigest: digestSchema,
    contextTierDigest: digestSchema,
    volatileTierDigest: digestSchema,
  })
  .strict()

const losslessProofSchema = z
  .object({
    schemaVersion: z.literal(SERVED_BRIEF_PROOF_SCHEMA_VERSION),
    completeness: z.literal('lossless'),
    recordCap: nonnegativeIntegerSchema,
    combinedBudget: nonnegativeIntegerSchema,
    admissionEvents: z.array(servedAdmissionEventSchema),
    promptTurns: z.array(servedPromptTurnSchema).min(1),
  })
  .strict()

export const LosslessServedBriefSchema = z
  .object({
    scope: scopeKeySchema,
    asOfBuild: nonnegativeIntegerSchema,
    budget: nonnegativeIntegerSchema,
    truncation: z.string(),
    channel1: z.array(BriefLineSchema),
    channel2: z.array(readTraceSchema),
    channel3: z.array(cautionLineSchema),
    briefDigest: digestSchema,
    proof: losslessProofSchema,
  })
  .strict()
  .superRefine((brief, context) => {
    for (const [index, event] of brief.proof.admissionEvents.entries()) {
      if (event.ordinal !== index) {
        context.addIssue({
          code: 'custom',
          path: ['proof', 'admissionEvents', index, 'ordinal'],
          message: 'expected a contiguous zero-based ordinal',
        })
      }
      if (
        index > 0 &&
        event.turnOrdinal < brief.proof.admissionEvents[index - 1].turnOrdinal
      ) {
        context.addIssue({
          code: 'custom',
          path: ['proof', 'admissionEvents', index, 'turnOrdinal'],
          message: 'expected nondecreasing turn order',
        })
      }
    }

    for (const [index, turn] of brief.proof.promptTurns.entries()) {
      if (turn.ordinal !== index) {
        context.addIssue({
          code: 'custom',
          path: ['proof', 'promptTurns', index, 'ordinal'],
          message: 'expected a contiguous zero-based ordinal',
        })
      }
      if (
        index > 0 &&
        turn.turnOrdinal < brief.proof.promptTurns[index - 1].turnOrdinal
      ) {
        context.addIssue({
          code: 'custom',
          path: ['proof', 'promptTurns', index, 'turnOrdinal'],
          message: 'expected nondecreasing turn order',
        })
      }

      const promptDigests = [
        ['policyDigest', turn.policyDigest, sha256hex(turn.policyL0)],
        ['contextTierDigest', turn.contextTierDigest, sha256hex(turn.contextTier)],
        ['volatileTierDigest', turn.volatileTierDigest, sha256hex(turn.volatileTier)],
      ] as const
      for (const [field, actual, expected] of promptDigests) {
        if (actual !== expected) {
          context.addIssue({
            code: 'custom',
            path: ['proof', 'promptTurns', index, field],
            message: 'prompt tier digest does not match its exact bytes',
          })
        }
      }
    }

    if (computeBriefDigest(brief) !== brief.briefDigest) {
      context.addIssue({
        code: 'custom',
        path: ['briefDigest'],
        message: 'brief digest does not match the lossless proof',
      })
    }
  })

function structuralPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.')
}

export class LosslessServedBriefError extends Error {
  readonly paths: readonly string[]

  constructor(paths: readonly (readonly PropertyKey[])[]) {
    const structuralPaths = [...new Set(paths.map(structuralPath))].sort()
    super(`Invalid lossless ServedBrief at ${structuralPaths.join(', ')}`)
    this.name = 'LosslessServedBriefError'
    this.paths = structuralPaths
  }
}

/** Parse untrusted persisted evidence without exposing prompt contents in diagnostics. */
export function guardLosslessServedBrief(value: unknown): LosslessServedBrief {
  const parsed = LosslessServedBriefSchema.safeParse(value)
  if (!parsed.success) {
    throw new LosslessServedBriefError(parsed.error.issues.map((issue) => issue.path))
  }
  return parsed.data
}
