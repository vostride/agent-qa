import type { Action, ActionAnnotation } from '@vostride/agent-qa-schema'

/** Stable same-screen descriptor for a recorded gold target. */
export interface GoldAnchorDescriptor {
  /** Recorded accessibility role used for semantic identity. */
  role: string
  /** Recorded normalized accessible name used for semantic identity. */
  nameNormalized: string
  /** Position among elements sharing the same role and normalized name. */
  ordinal: number
  /** Evidence-only recorded ref; it is never part of cross-run identity. */
  ref?: string
}

/** Matcher inputs projected from one recorded decision. */
export interface CassetteSidecarLeg {
  /** Eval-owned copy of the recorded action selected by the planner. */
  goldAction: Action
  /** Recorded verb copied verbatim; matcher class semantics are applied later. */
  opClass: string
  /** Recorded value for value-bearing operations; absence is not fabricated. */
  goldValue?: string
  /** Resolved semantic target; legitimately absent for coordinate-only actions. */
  goldAnchor?: GoldAnchorDescriptor
  /** Gold target plus action-equivalent wrappers or descendants. */
  equivalenceSet: readonly GoldAnchorDescriptor[]
  /** Recorded interaction geometry used by coordinate matching. */
  annotation?: ActionAnnotation
}
