// Equal role, equal tidied exact name and stated row words in a known row; it never picks.

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
