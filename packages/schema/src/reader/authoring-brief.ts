// D-13/D-16/ABRF-01 authoring-brief assembly-output contracts. Mirrors the BriefBlock /
// CautionBlock idiom: an assembled, budgeted block carrying its exact admission material.

import type { BriefLine, CautionLine } from '../brief/served-brief'
import type { Anchor } from '../identity/anchor'
import type { ProcedureMatch } from './reader-types'
import type { ServingRecordMetadata } from './serving-admission'

/**
 * One exemplar test reference: refs + outcome metadata + a short budget-aware excerpt
 * (title + step outline) — NEVER full inline test text. The consumer reads the file on demand;
 * tests are its repo's files.
 */
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

/**
 * The assembled authoring brief. Locked tight-budget precedence when the budget
 * cannot fit everything: caution > procedure > exemplar > fact — the 381-08 assembly and every
 * future consumer read the ordering from THIS contract, not a call site.
 */
export interface AuthoringBrief {
  exemplars: ExemplarTest[]
  procedures: ProcedureMatch[]
  facts: BriefLine[]
  cautions: CautionLine[]
  /** NON-optional: typed-empty until M4 populates it. */
  coverage: CoverageMap
  truncation: string
  /** Exact admission material for every served record, the ServingRecordMetadata way. */
  admissions: ServingRecordMetadata[]
}
