// Redacts registered secrets at capture only; everything else stays verbatim until snapshot.

import type { WorkingMemoryEntry } from '@vostride/agent-qa-schema'
import { workingMemoryEntrySchema } from '@vostride/agent-qa-schema'
import type { SecretRedactorPort } from '../ports.js'
import { redactSecretValue } from '../secrets.js'

// Marks each entry's capture location; the planner weighs relevance itself, so it is no filter.
export interface WorkingMemoryProvenanceContext {
  test?: number
  step?: number
}

// Latest wins on re-capture, because an OTP resend replaces the value; recall is the whole set.
export class WorkingMemoryStore {
  private readonly store = new Map<string, WorkingMemoryEntry>()

  constructor(private readonly redactor?: SecretRedactorPort) {}

  // Re-capturing a key overwrites its value but keeps its original position.
  capture(entries: readonly WorkingMemoryEntry[], ctx?: WorkingMemoryProvenanceContext): void {
    for (const raw of entries) {
      const parsed = workingMemoryEntrySchema.parse(raw)
      const stored: WorkingMemoryEntry = {
        ...parsed,
        value: redactSecretValue(parsed.value, this.redactor),
      }
      if (ctx?.test !== undefined) stored.testIndex = ctx.test
      if (ctx?.step !== undefined) stored.stepIndex = ctx.step
      this.store.set(stored.key, stored)
    }
  }

  // The whole run-scoped set in capture order, unfiltered.
  entries(): WorkingMemoryEntry[] {
    return [...this.store.values()]
  }

  // Empties the store at run end; the redacted flush is composed elsewhere.
  dispose(): void {
    this.store.clear()
  }
}
