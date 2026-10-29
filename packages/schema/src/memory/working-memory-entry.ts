import { z } from 'zod'

/**
 * The schema-owned run-scoped working-memory vocabulary.
 * A `WorkingMemoryEntry` is one verbatim fact the planner captured mid-run via the
 * ratified `remember[]` plan-field (spec `tools-and-actions.md` §12.15, write channel
 * ratified 2026-07-05 — not a tool, no catalog change). The enums are CLOSED: the
 * planner cannot mint new categories, and unknown values are rejected at the plan-field
 * boundary (V5 input validation of untrusted model output).
 *
 * Pure DTO + zod validator only: no host or runtime IO APIs — the schema-package
 * ownership contract (pure sync types + zod).
 */
export interface WorkingMemoryEntry {
  /** Exact-recall key. Latest-wins on re-capture; one key ⇒ one current value. */
  key: string
  /** The verbatim captured value, kept masked in snapshots/flush (never unmasked). */
  value: string
  /** Closed category of the captured fact. */
  kind: 'code' | 'filename' | 'extracted-value' | 'progress-marker'
  /** Closed provenance of how the planner obtained the value. */
  provenance: 'observation' | 'toolResult' | 'plannerInference'
  /**
   * Optional capture-location context: the whole run set is served every turn,
   * so the planner weighs relevance itself — these carry where the entry was captured,
   * not a filter rule.
   */
  testIndex?: number
  stepIndex?: number
}

const workingMemoryKindValues = [
  'code',
  'filename',
  'extracted-value',
  'progress-marker',
] as const satisfies readonly WorkingMemoryEntry['kind'][]

const workingMemoryProvenanceValues = [
  'observation',
  'toolResult',
  'plannerInference',
] as const satisfies readonly WorkingMemoryEntry['provenance'][]

export const workingMemoryEntrySchema = z
  .object({
    key: z.string(),
    value: z.string(),
    kind: z.enum(workingMemoryKindValues),
    provenance: z.enum(workingMemoryProvenanceValues),
    testIndex: z.number().optional(),
    stepIndex: z.number().optional(),
  })
  .strict()
