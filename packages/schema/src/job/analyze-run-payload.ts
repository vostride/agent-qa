// The `analyze-run` job payload, mirrored as a schema (Phase 393, D-20).
//
// TWO READERS, DELIBERATELY ASYMMETRIC. The hand-rolled reader in `agent/src/jobs/kinds.ts`
// stays additive-tolerant: it reads a payload written by an earlier build off a durable queue,
// where an unknown key means "a newer producer wrote this" and refusing it would strand jobs.
// This schema validates the PRODUCER side, at the enqueue site, where the shape is fully
// controlled and a stray key means a bug in the code that just built it. Strictness belongs on
// the half that can act on the refusal — putting it on the reader would be a regression
// generator, and putting it nowhere is how a silently-dropped field ships.
//
// THE TWO FLAGS ARE QUEUE-LEVEL VISIBILITY, NOT INTEGRITY. `gateRun` and `excludedFromOutcomes`
// already live inside the handoff, and `handoffDigest` already covers the handoff's bytes — so
// copying them here adds no integrity guarantee whatsoever. What it adds is the ability to see
// what a queued job IS without loading the handoff it points at, which is WTST-06's ratified
// sentence taken literally. Anyone tempted to treat these copies as authoritative should read
// the digest instead.

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
  /**
   * D-10 verify-before-present gate-run marker, copied from the handoff carrier.
   *
   * A DISTINCT axis from `excludedFromOutcomes` below — neither marker implies the other, and
   * C8 ratified that gate runs DO feed curation. Only the literal marker is meaningful, exactly
   * as on `completed-run-handoff.ts`: `false` is a refusal rather than a synonym for absence,
   * so a producer cannot half-express the flag.
   */
  gateRun: z.literal(true).optional(),
  /** D-14 §6 outcome-exclusion marker, copied from the handoff carrier. Same literal-only rule. */
  excludedFromOutcomes: z.literal(true).optional(),
}).strict()

export type AnalyzeRunPayload = z.infer<typeof AnalyzeRunPayloadSchema>
