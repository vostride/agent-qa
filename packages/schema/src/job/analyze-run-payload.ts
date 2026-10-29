// The reader tolerates unknown keys from earlier builds; strictness is on the producer side.

import { z } from 'zod'

import { EXECUTION_CONTEXT_VALUES } from '../run/run-status'

export const AnalyzeRunPayloadSchema = z.object({
  /** The run to analyse. */
  runId: z.string().min(1),
  /**
   * Digest of the handoff bytes being analysed, minted ONCE per run and shared with the
   * receipt — a second mint would be a second answer to "which bytes were analysed".
   */
  handoffDigest: z.string().min(1),
  handoffSchemaVersion: z.number().int().nonnegative(),
  /**
   * Optional because the hand-rolled reader has always treated it as optional; the enqueue
   * site does in practice always carry it.
   */
  executionContext: z.enum(EXECUTION_CONTEXT_VALUES).optional(),
  // Separate from `excludedFromOutcomes`; only `true` is meaningful and `false` is refused.
  gateRun: z.literal(true).optional(),
  // Outcome-exclusion marker copied from the handoff carrier; only `true` is admitted.
  excludedFromOutcomes: z.literal(true).optional(),
}).strict()

export type AnalyzeRunPayload = z.infer<typeof AnalyzeRunPayloadSchema>
