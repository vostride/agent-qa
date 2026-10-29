import { z } from 'zod'

import { asEvidenceToken, asRecordId } from '../ids/record-id'

/**
 * The §7.5 trust-prior origin classes. This vocabulary is deliberately separate
 * from DeltaEnvelope.origin, which records producer-stage provenance rather than
 * the strength of the evidence source used by the Beta fold.
 */
export type OriginClass = 'user' | 'agent-verified' | 'agent-observed' | 'import'

const originClassValues = [
  'user',
  'agent-verified',
  'agent-observed',
  'import',
] as const satisfies readonly OriginClass[]

const commonEventShape = {
  evidenceToken: z.string().transform(asEvidenceToken),
  curationJobId: z.string(),
  buildOrdinal: z.number(),
  observationOrdinal: z.number().optional(),
  observationId: z.string().optional(),
}

const originClassSchema = z.enum(originClassValues)
export const OVERTURNED_EVENT_TYPE = 'overturned' as const
const observationVariant = <T extends 'confirmed' | 'contradicted' | 'helpful' | 'harmful'>(
  type: T,
) => z.object({
  ...commonEventShape,
  type: z.literal(type),
  origin: originClassSchema.optional(),
}).strict()

/**
 * The ONE canonical outcomes log carries attributed observations and explicit
 * lifecycle events. Helpful/harmful are minted now for Phase 380 attribution but
 * have no producer yet. Every line is real evidence or an explicit lifecycle
 * transition: evidence-incomplete is a prior discount, never a synthetic event
 * Lines are append-only and never rewritten after commit.
 *
 * Event lines intentionally carry no schemaVersion; the containing bundle manifest
 * governs their format version.
 */
export const BundleOutcomeEventSchema = z.discriminatedUnion('type', [
  observationVariant('confirmed'),
  observationVariant('contradicted'),
  observationVariant('helpful'),
  observationVariant('harmful'),
  z.object({
    ...commonEventShape,
    type: z.literal('superseded'),
    byRecordId: z.string().transform(asRecordId),
  }).strict(),
  /**
   * 379 D-15 RATIFICATION: one retracted event replaces a bespoke window-reopen
   * event. Matching the retracted evidence/job identity inverts confirmed,
   * deprecated, superseded, and window-close effects through one fold rule, so
   * retracting a victim's superseded and window-close events is the typed
   * restoration that both reopens its window and re-derives its prior status.
   */
  z.object({
    ...commonEventShape,
    type: z.literal('retracted'),
    retractsEvidenceToken: z.string().transform(asEvidenceToken),
    retractsCurationJobId: z.string(),
    rollbackReceiptId: z.string(),
  }).strict(),
  z.object({
    ...commonEventShape,
    type: z.literal('deprecated'),
    reason: z.string(),
  }).strict(),
  z.object({
    ...commonEventShape,
    type: z.literal('promoted'),
  }).strict(),
  z.object({
    ...commonEventShape,
    type: z.literal('window-close'),
    closedAtOrdinal: z.number(),
  }).strict(),
  /**
   * a compensating line beside the evidence a user mark
   * overturned — evidence only; no status moves here.
   */
  z.object({
    ...commonEventShape,
    type: z.literal(OVERTURNED_EVENT_TYPE),
    overturnsEvidenceToken: z.string().transform(asEvidenceToken),
    overturnsCurationJobId: z.string(),
    markId: z.string().regex(/^mark_[0-9a-f]{12}$/),
  }).strict(),
])

export type BundleOutcomeEvent = z.infer<typeof BundleOutcomeEventSchema>

/**
 * Derivation-level replay identity within one bundle. The record id is implicit
 * because a fold never spans bundle directories.
 */
export function eventDedupKey(event: BundleOutcomeEvent): string {
  return `${event.evidenceToken}:${event.curationJobId}`
}

/** First-wins, order-preserving defense against replayed outcome lines. */
export function dedupeEvents(events: readonly BundleOutcomeEvent[]): BundleOutcomeEvent[] {
  const keys = new Set<string>()
  const deduped: BundleOutcomeEvent[] = []

  for (const event of events) {
    const key = eventDedupKey(event)
    if (keys.has(key)) continue
    keys.add(key)
    deduped.push(event)
  }

  return deduped
}

/**
 * Canonical lifecycle-effect sequence after append replay and rollback are
 * interpreted. Retraction audit lines remain in the input log but never become
 * effects themselves. Dedupe must run before target collection so a replayed
 * retraction identity retains the same first-wins law as every other event.
 */
export function survivingOutcomeEvents(
  events: readonly BundleOutcomeEvent[],
): BundleOutcomeEvent[] {
  const dedupedEvents = dedupeEvents(events)
  const retractedEventKeys = new Set<string>()
  const overturnedEventKeys = new Set<string>()

  for (const event of dedupedEvents) {
    if (event.type === 'overturned') {
      overturnedEventKeys.add(`${event.overturnsEvidenceToken}:${event.overturnsCurationJobId}`)
      continue
    }
    if (event.type !== 'retracted') continue
    retractedEventKeys.add(eventDedupKey({
      ...event,
      evidenceToken: event.retractsEvidenceToken,
      curationJobId: event.retractsCurationJobId,
    }))
  }

  return dedupedEvents.filter(
    (event) => {
      if (event.type === 'retracted' || event.type === 'overturned') return false
      if (retractedEventKeys.has(eventDedupKey(event))) return false
      // even a malformed citation cannot cancel a lifecycle transition.
      const isObservation = event.type === 'confirmed' || event.type === 'contradicted'
        || event.type === 'helpful' || event.type === 'harmful'
      return !isObservation || !overturnedEventKeys.has(eventDedupKey(event))
    },
  )
}
