// Strict cache re-grounding (Phase 357 seam; 438 D-10/D-11).
// CRITICAL: storage-neutral — no node:* imports. A stored locator replays only onto the one
// element of the fresh observation with its role, exact name and stated row words
// (grounding/strict-match.ts). There is no role-ignored or substring rung, no position and no
// hierarchy tiebreak on replay: none or several survivors is a typed outcome the loop turns into
// a miss (invalidate → replan), so a stored target never drives a pick.

import type { ElementInfo } from '@vostride/agent-qa-schema'
import { strictMatch } from '../grounding/strict-match.js'
import type { StrictMatchResult } from '../grounding/strict-match.js'
import type { GroundedLocator } from './value.js'

export interface GroundingStrategy {
  reground(locator: GroundedLocator, elements: readonly ElementInfo[]): StrictMatchResult
}

export const deterministicDescriptorMatcher: GroundingStrategy = {
  reground(locator, elements) {
    return strictMatch(locator, elements)
  },
}
