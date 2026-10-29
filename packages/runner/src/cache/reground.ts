// None or several survivors is a typed outcome the loop turns into a miss, never a pick.

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
