import type { Ref } from '../primitives/ref'

// Every field is optional so the cache's `GroundedLocator` stays structurally assignable.
export interface TargetDescriptor {
  /**
   * Accessibility role of the target element (e.g. 'button', 'textbox').
   */
  role?: string
  // Required by the matcher: a descriptor without a `name` gets a structured grounding error.
  name?: string
  // Reserved for proximity matching: absent from the tool schemas and rejected by the matcher.
  near?: string
  // Identity for checking and replay, never a search hint.
  row?: string
  // Read from older handoffs only: nothing writes it and no path selects by it.
  ordinal?: number
}

// One entry per rung that runs; an unattempted visual rung records `skipped`.
export interface GroundingAttempt {
  stage: 'ref' | 'tree-search' | 'visual'
  outcome: 'resolved' | 'no-match' | 'skipped'
  resolvedRef?: Ref
}

// Recorded after redaction, so untrusted planner text never persists raw into evidence.
export interface GroundingEvidence {
  descriptor: TargetDescriptor
  attempts: GroundingAttempt[]
  // Redacted like the descriptor; `row` is absent when the planner stated no row words.
  stated?: { role?: string; name: string; row?: string }
}
