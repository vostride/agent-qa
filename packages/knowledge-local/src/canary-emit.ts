import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import {
  canonicalJson,
  sha256hex,
  type Benefit,
  type CanaryOutcome,
  type StateValidity,
} from '@vostride/agent-qa-schema'

import { anchorSchema } from './anchor-schema.js'
import { assertWithinKnowledgeRoot } from './knowledge-containment.js'
import {
  bestEffortFsyncDirectory,
  durableWrite,
  publishStagedQueueEntry,
  queueStagingRoot,
  queuedCandidateDir,
  queuedRoot,
  removeEmptyDir,
} from './queue-transport.js'

export const CANARY_QUEUE_SCHEMA_VERSION = 2

// 2026-09-07, 418 SC1: pin persisted payload.json vocabulary in edited local source.
// satisfies bounds membership; the test-d never-bars enforce completeness.
// prettier-ignore
export const PAYLOAD_BENEFITS = ['exercised-benefited', 'rode-along', 'exercised-harmed'] as const satisfies readonly Benefit[]
// prettier-ignore
export const PAYLOAD_STATE_VALIDITIES = ['valid', 'stale', 'unknown'] as const satisfies readonly StateValidity[]

const canaryOutcomePayloadBaseShape = {
  jobKind: z.literal('canary-outcome'),
  candidateId: z.string().min(1),
  runId: z.string().min(1),
  testId: z.string().min(1),
  testIndex: z.number().int().nonnegative(),
  buildOrdinal: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  outcome: z.enum(['positive', 'negative']),
  exercisedAnchor: anchorSchema,
  attribution: z.string(),
  briefDigest: z.string().min(1),
} as const

const digest = z.string().regex(/^[0-9a-f]{64}$/)
export const canaryOutcomePayloadSchema = z
  .object({
    ...canaryOutcomePayloadBaseShape,
    schemaVersion: z.literal(CANARY_QUEUE_SCHEMA_VERSION),
    benefit: z.enum(PAYLOAD_BENEFITS),
    stateValidity: z.enum(PAYLOAD_STATE_VALIDITIES),
    observedStateDigest: digest.optional(),
  })
  .strict()

// Diagnostic wall-clock metadata never participates in durable identity.
const diagnosticShape = { emittedAt: z.string().optional() }
const canaryOutcomeAddressFieldsSchema = canaryOutcomePayloadSchema.extend(diagnosticShape)

export type CanaryOutcomePayload = z.infer<typeof canaryOutcomePayloadSchema>
export type QueuedCanaryPayloadRead =
  | { kind: 'current'; payload: CanaryOutcomePayload }
  | { kind: 'refused'; issues: string[] }

export function readQueuedCanaryPayload(value: unknown): QueuedCanaryPayloadRead {
  const parsed = canaryOutcomePayloadSchema.safeParse(value)
  if (!parsed.success) {
    // Queued bytes are untrusted: never echo their values or unknown keys in diagnostics.
    return { kind: 'refused', issues: ['Invalid queued canary payload'] }
  }
  return { kind: 'current', payload: parsed.data }
}
export type CanaryOutcomeAddressFields = z.infer<
  typeof canaryOutcomeAddressFieldsSchema
>

/** Content-address all attribution authority while excluding diagnostic wall-clock metadata. */
export function canaryOutcomeContentAddress(
  fields: CanaryOutcomeAddressFields,
): string {
  const parsed = canaryOutcomeAddressFieldsSchema.parse(fields)
  const { emittedAt: _diagnostic, ...deterministic } = parsed
  return sha256hex(canonicalJson(deterministic))
}

export type EnqueueCanaryOutcome =
  | { kind: 'enqueued'; entryId: string }
  | { kind: 'coalesced'; entryId: string }

/**
 * D-20's one emit pattern: synchronously publish with the same durable staging and rename
 * semantics as a curation drop, so crashes and retries cannot multiply one attributed outcome.
 */
export function enqueueCanaryOutcome(
  knowledgeRoot: string,
  outcome: CanaryOutcome,
): EnqueueCanaryOutcome {
  const payload = canaryOutcomePayloadSchema.parse({
    schemaVersion: CANARY_QUEUE_SCHEMA_VERSION,
    jobKind: 'canary-outcome',
    candidateId: outcome.candidateId,
    runId: outcome.runId,
    testId: outcome.testId,
    testIndex: outcome.testIndex,
    buildOrdinal: outcome.buildOrdinal,
    stepIndex: outcome.stepIndex,
    outcome: outcome.runOutcome,
    benefit: outcome.benefit,
    stateValidity: outcome.stateValidity,
    ...(outcome.observedStateDigest === undefined ? {} : { observedStateDigest: outcome.observedStateDigest }),
    exercisedAnchor: outcome.exercisedAnchor,
    attribution: outcome.attribution,
    briefDigest: outcome.briefDigest,
  })
  const entryId = canaryOutcomeContentAddress(payload)
  const stagingRoot = queueStagingRoot(knowledgeRoot)
  assertWithinKnowledgeRoot(knowledgeRoot, stagingRoot)
  assertWithinKnowledgeRoot(knowledgeRoot, queuedRoot(knowledgeRoot))
  const stagingDir = join(stagingRoot, randomUUID())
  mkdirSync(stagingDir, { recursive: true })
  try {
    durableWrite(join(stagingDir, 'payload.json'), `${canonicalJson(payload)}\n`)
    bestEffortFsyncDirectory(stagingDir)
    const published = publishStagedQueueEntry(
      stagingDir,
      queuedCandidateDir(knowledgeRoot, entryId),
      queuedRoot(knowledgeRoot),
    )
    return {
      kind: published === 'published' ? 'enqueued' : 'coalesced',
      entryId,
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
    removeEmptyDir(stagingRoot)
  }
}
