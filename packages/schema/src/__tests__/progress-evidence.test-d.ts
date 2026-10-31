import { expectTypeOf, test } from 'vitest'
import type { z } from 'zod'
import type {
  CycleEvidence,
  LocalEffectEvidence,
  StagnationClass,
  StagnationEvidence,
} from '../handoff/progress-evidence'
import type { StepEvidence } from '../handoff/step-evidence'
import type { SubActionEvidence } from '../handoff/sub-action-evidence'
import type { WorkingMemoryEntry } from '../memory/working-memory-entry'
import { workingMemoryEntrySchema } from '../memory/working-memory-entry'

test('working memory entries have closed kinds and provenances', () => {
  expectTypeOf<z.infer<typeof workingMemoryEntrySchema>>().toEqualTypeOf<WorkingMemoryEntry>()

  expectTypeOf<WorkingMemoryEntry['kind']>().toEqualTypeOf<
    'code' | 'filename' | 'extracted-value' | 'progress-marker'
  >()
  expectTypeOf<WorkingMemoryEntry['provenance']>().toEqualTypeOf<
    'observation' | 'toolResult' | 'plannerInference'
  >()
  expectTypeOf<WorkingMemoryEntry['testIndex']>().toEqualTypeOf<number | undefined>()
  expectTypeOf<WorkingMemoryEntry['stepIndex']>().toEqualTypeOf<number | undefined>()
})

test('local effect, stagnation and cycle evidence have fixed shapes', () => {
  expectTypeOf<LocalEffectEvidence['oracle']>().toEqualTypeOf<
    'fill-reread' | 'scroll' | 'checkable-state' | 'navigation' | 'hash-fallback'
  >()
  expectTypeOf<LocalEffectEvidence['achieved']>().toEqualTypeOf<boolean>()

  expectTypeOf<StagnationClass>().toEqualTypeOf<
    'transient-load' | 'obstruction' | 'off-screen' | 'input-didnt-land' | 'unresponsive'
  >()
  expectTypeOf<StagnationEvidence['counts']>().toEqualTypeOf<
    Array<{ class: StagnationClass; count: number }>
  >()
  expectTypeOf<StagnationEvidence['total']>().toEqualTypeOf<number>()

  expectTypeOf<CycleEvidence['windowSummary']>().toEqualTypeOf<string[]>()
})

test('step and sub-action evidence carry progress evidence as optional fields', () => {
  // Additive §A8 extensions — all optional, existing consumers compile unchanged.
  expectTypeOf<StepEvidence['workingMemory']>().toEqualTypeOf<WorkingMemoryEntry[] | undefined>()
  expectTypeOf<StepEvidence['stagnation']>().toEqualTypeOf<StagnationEvidence | undefined>()
  expectTypeOf<StepEvidence['cycle']>().toEqualTypeOf<CycleEvidence | undefined>()
  expectTypeOf<SubActionEvidence['localEffect']>().toEqualTypeOf<LocalEffectEvidence | undefined>()
})
