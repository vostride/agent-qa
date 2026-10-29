// Recorded per run, never re-derived: it describes the host's ladder, not how a line was ranked.

import { z } from 'zod'

// Best first; `bundle-scan` runs no dense leg whatever the embedder, so the index axis folds first.
export const RETRIEVAL_RUNGS = ['memidex', 'bundle-scan', 'static-floor', 'lexical-only'] as const

export type RetrievalRung = (typeof RETRIEVAL_RUNGS)[number]

// `index-unavailable` appears only in older runs: no fold mints it and no reader reinterprets it.
export const RETRIEVAL_RUNG_REASONS = [
  'native-runtime-unavailable',
  'profile-unresolved',
  'model-not-downloaded',
  'embedder-load-failed',
  'index-unavailable',
  'floor-disabled',
  'profile-static-configured',
  'index-not-built',
  'index-locked',
  'index-corrupt',
] as const

export type RetrievalRungReason = (typeof RETRIEVAL_RUNG_REASONS)[number]

/** A recorded rung carries the current reason vocabulary. */
export const RecordedRetrievalRungSchema = z.object({
  schemaVersion: z.literal(2),
  rung: z.enum(RETRIEVAL_RUNGS),
  reason: z.enum(RETRIEVAL_RUNG_REASONS).optional(),
}).strict()

export type RecordedRetrievalRung = z.infer<typeof RecordedRetrievalRungSchema>
