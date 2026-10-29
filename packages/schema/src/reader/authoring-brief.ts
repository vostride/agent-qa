// An assembled, budgeted block carrying its exact admission material, like `BriefBlock`.

import type { BriefLine, CautionLine } from '../brief/served-brief'
import type { Anchor } from '../identity/anchor'
import type { ProcedureMatch } from './reader-types'
import type { ServingRecordMetadata } from './serving-admission'

// Never full inline test text: the consumer reads the file on demand.
export interface ExemplarTest {
  filePath: string
  testName: string
  matchedAnchors: Anchor[]
  passRate?: number
  recentOutcomes?: { buildOrdinal: number; passed: boolean }[]
  /** True when outcome metadata could not be confirmed against completed-run handoffs. */
  unverifiedOutcomes: boolean
  excerpt: string
}

/**
 * Typed-empty placeholder: nothing mints coverage data. The field exists with an empty value on
 * every AuthoringBrief, never an absent optional a consumer would have to feature-detect.
 */
export type CoverageMap = Record<string, never>

// Tight-budget precedence: caution, then procedure, then exemplar, then fact.
export interface AuthoringBrief {
  exemplars: ExemplarTest[]
  procedures: ProcedureMatch[]
  facts: BriefLine[]
  cautions: CautionLine[]
  // Required even when empty.
  coverage: CoverageMap
  truncation: string
  /** Exact admission material for every served record, the ServingRecordMetadata way. */
  admissions: ServingRecordMetadata[]
}
