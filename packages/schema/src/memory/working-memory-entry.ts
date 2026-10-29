import { z } from 'zod'

// Closed enums: the planner mints no category, and unknown values are refused at the plan field.
export interface WorkingMemoryEntry {
  /** Exact-recall key. Latest-wins on re-capture; one key ⇒ one current value. */
  key: string
  /** The verbatim captured value, kept masked in snapshots/flush (never unmasked). */
  value: string
  /** Closed category of the captured fact. */
  kind: 'code' | 'filename' | 'extracted-value' | 'progress-marker'
  /** Closed provenance of how the planner obtained the value. */
  provenance: 'observation' | 'toolResult' | 'plannerInference'
  // The whole run set is served each turn; these record where it was captured, not a filter.
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
