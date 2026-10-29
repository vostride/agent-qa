// The strict matcher. The one matcher the heal, the cache and procedure
// replay use to re-find an element they already saw.
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp, no
// core/model/adapter package imports — imports only schema types.
//
// An element is the same one only when its role is equal, its exact name is equal after tidying
// (leading and trailing whitespace trimmed, inner whitespace runs collapsed to one space — case,
// digits and badges kept), and, when the target names row words, its own row is known and holds
// them (row-text.ts). Exactly one survivor resolves; none is absent; more is not-unique with the
// count. There is no role-ignored rung, no substring rung, no position and no hierarchy tiebreak:
// the matcher never picks.
//
// M2 injection boundary: names and row text are opaque comparison data only — never interpolated
// into a selector or an instruction, never evaluated.
//
// Pure functions: no recording, no side effects.

import type { ElementInfo, Ref } from '@vostride/agent-qa-schema'
import { rowContains, rowTextOf, wordTokens } from './row-text.js'

/** The identity an element must have to be the one already seen. */
export interface StrictTarget {
  role: string
  name: string
  row?: string
}

export type StrictMatchResult =
  | { kind: 'resolved'; ref: Ref }
  | { kind: 'absent' }
  | { kind: 'not-unique'; count: number }

/** An exact name with surrounding whitespace trimmed and inner whitespace runs collapsed. */
export function tidyName(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

/** The one element of `elements` with the target's role, exact name and row words, if unique. */
export function strictMatch(
  target: StrictTarget,
  elements: readonly ElementInfo[],
): StrictMatchResult {
  const name = tidyName(target.name)
  const statedRow = wordTokens(target.row).length > 0 ? target.row : undefined
  const survivors = elements.filter((element) => {
    if (element.role !== target.role || tidyName(element.name) !== name) return false
    if (statedRow === undefined) return true
    const row = rowTextOf(element, elements)
    return row !== undefined && rowContains(row, statedRow)
  })
  if (survivors.length === 1) return { kind: 'resolved', ref: survivors[0].ref }
  if (survivors.length === 0) return { kind: 'absent' }
  return { kind: 'not-unique', count: survivors.length }
}
