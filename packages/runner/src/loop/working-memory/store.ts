// Run-scoped working-memory store (Phase 358 · WM-01 · D-11/D-12 · Pattern 6 · Pitfall 7).
// CRITICAL: provider-neutral + storage-neutral. No node:* imports — the instance lives at
// the CLI composition root and is threaded through LoopPorts; Phase 361 rebinds it onto
// RunSession without touching this class.
//
// spec §12.15 M1 build note: a plain map + exact-key recall is the whole store — the memidex
// engine / vector recall is M2's scale valve, never M1. The runner writes ONLY to this
// run-scoped store; durable memory is the curator's (M2).
//
// Pitfall 7 — three distinct redaction boundaries: (1) redactSecretValue at CAPTURE here
// (registered secrets only — everything else is kept VERBATIM); (2) the store + turn content
// stay verbatim (the planner needs the real OTP); (3) mask() applies only at snapshot/flush
// (StepEvidence.workingMemory / the WM-02 flush — elsewhere). This class owns boundary 1 only.

import type { WorkingMemoryEntry } from '@vostride/agent-qa-schema'
import { workingMemoryEntrySchema } from '@vostride/agent-qa-schema'
import type { SecretRedactorPort } from '../ports.js'
import { redactSecretValue } from '../secrets.js'

/**
 * Capture-location context stamped onto each entry: the whole run set is served every
 * turn, so the planner weighs relevance itself — these mark where the entry was captured, they
 * are not a filter rule.
 */
export interface WorkingMemoryProvenanceContext {
  test?: number
  step?: number
}

/**
 * Run-scoped verbatim working memory: a plain Map keyed by entry key, latest-wins on
 * re-capture (D-12 — one key ⇒ one current value, the OTP-resend reality), whole-set recall in
 * capture order (D-11 — no filtering, no search). Registered secrets are redacted at capture
 * (Pitfall 7 boundary 1); every other value stays verbatim.
 */
export class WorkingMemoryStore {
  private readonly store = new Map<string, WorkingMemoryEntry>()

  constructor(private readonly redactor?: SecretRedactorPort) {}

  /**
   * Capture verbatim entries. Each item is validated against workingMemoryEntrySchema (closed
   * enums reject unknown kind/provenance at the boundary, V5), its value redacted for registered
   * secrets only, and stamped with the capture location. Re-capturing an existing key overwrites
   * its value (D-12 latest-wins); the key's original capture position is preserved.
   */
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

  /** The whole run-scoped set in capture order (D-11 — no filtering, no search). */
  entries(): WorkingMemoryEntry[] {
    return [...this.store.values()]
  }

  /** Empty the store at run end (WM-02 disposal; the redacted flush is composed elsewhere). */
  dispose(): void {
    this.store.clear()
  }
}
