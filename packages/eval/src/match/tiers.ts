import type {
  Action,
  ActionAnnotation,
  ScreenStateMetadata,
} from '@vostride/agent-qa-schema'

import type { CassetteSidecarLeg } from '../cassette/sidecar-leg'
import type { DecisionIdentity } from '../replay/identity'
import { MATCHER_CONFIG } from './config'
import type { IdentityLadderLevel } from './config'
import { classifyAnchorLadder } from './ladder'
import { classifyOpClass, opClassEquivalent } from './op-class'

// Operation-class verdict from the hard gate.
export type OpClassVerdict =
  | { kind: 'match'; opClass: string }
  | { kind: 'mismatch'; goldClass: string; candidateClass: string }

// Element-identity evidence, including every counted degradation cause.
export type ElementIdentityVerdict =
  | { kind: 'scored'; level: IdentityLadderLevel; numeric: number; tier: 2 | 3 }
  | {
      kind: 'unscorable'
      cause: 'no-gold-evidence' | 'no-candidate-geometry' | 'coordspace-mismatch'
    }
  | { kind: 'not-evaluated' }

/** Highest deterministic tier reached together with the two verdict axes produced here. */
export interface TierMatchResult {
  tierReached: 1 | 2 | 3
  opClass: OpClassVerdict
  elementIdentity: ElementIdentityVerdict
}

export interface MatchTierCandidate {
  identity: DecisionIdentity
  action: Action
}

interface CandidatePoint {
  x: number
  y: number
  coordSpace: 'viewport' | 'content' | 'screen'
}

function scoredIdentity(level: IdentityLadderLevel, tier: 2 | 3): ElementIdentityVerdict {
  return {
    kind: 'scored',
    level,
    numeric: MATCHER_CONFIG.identityLadder[level],
    tier,
  }
}

function candidatePoint(action: Action): CandidatePoint | undefined {
  const view = action as unknown as Record<string, unknown>
  if (
    typeof view.x !== 'number' ||
    typeof view.y !== 'number' ||
    !Number.isFinite(view.x) ||
    !Number.isFinite(view.y) ||
    (view.coordSpace !== 'viewport' &&
      view.coordSpace !== 'content' &&
      view.coordSpace !== 'screen')
  ) {
    return undefined
  }
  return { x: view.x, y: view.y, coordSpace: view.coordSpace }
}

function hasCandidatePoint(action: Action): boolean {
  return candidatePoint(action) !== undefined
}

function pointInsideBounds(
  point: CandidatePoint,
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  )
}

// Tier 3 scores only inside the recorded coordinate space; a space mismatch is a counted verdict.
function scoreTier3(
  annotation: ActionAnnotation,
  action: Action,
  stateMetadata?: ScreenStateMetadata,
): ElementIdentityVerdict {
  const point = candidatePoint(action)
  if (point === undefined) {
    return { kind: 'unscorable', cause: 'no-candidate-geometry' }
  }

  if (stateMetadata !== undefined && point.coordSpace !== stateMetadata.coordSpace) {
    return { kind: 'unscorable', cause: 'coordspace-mismatch' }
  }

  if (annotation.kind !== 'point') {
    return { kind: 'unscorable', cause: 'no-gold-evidence' }
  }

  if (
    annotation.point.boundingBox !== undefined &&
    pointInsideBounds(point, annotation.point.boundingBox)
  ) {
    return scoredIdentity('full', 3)
  }

  const viewportDiagonal = Math.hypot(annotation.viewport.width, annotation.viewport.height)
  if (viewportDiagonal === 0 || !Number.isFinite(viewportDiagonal)) {
    return { kind: 'unscorable', cause: 'no-gold-evidence' }
  }

  const normalizedDistance =
    Math.hypot(point.x - annotation.point.x, point.y - annotation.point.y) / viewportDiagonal
  const level: IdentityLadderLevel =
    normalizedDistance <= MATCHER_CONFIG.tier3.distanceToleranceRatio
      ? 'within-tolerance'
      : 'miss'
  return scoredIdentity(level, 3)
}

// An operation-class mismatch returns before any identity or geometry work runs.
export function runMatchTiers(
  sidecar: CassetteSidecarLeg,
  candidate: MatchTierCandidate,
  stateMetadata?: ScreenStateMetadata,
): TierMatchResult {
  const goldClass = classifyOpClass(sidecar.opClass)
  const candidateClass = classifyOpClass(candidate.identity.opClass)

  if (!opClassEquivalent(sidecar.opClass, candidate.identity.opClass)) {
    return {
      tierReached: 1,
      opClass: { kind: 'mismatch', goldClass, candidateClass },
      elementIdentity: { kind: 'not-evaluated' },
    }
  }

  const opClass: OpClassVerdict = { kind: 'match', opClass: goldClass }

  if (sidecar.goldAnchor !== undefined) {
    if (candidate.identity.target !== undefined) {
      const level = classifyAnchorLadder(
        candidate.identity.target,
        sidecar.goldAnchor,
        sidecar.equivalenceSet,
      )
      return { tierReached: 2, opClass, elementIdentity: scoredIdentity(level, 2) }
    }

    if (sidecar.annotation !== undefined && hasCandidatePoint(candidate.action)) {
      return {
        tierReached: 3,
        opClass,
        elementIdentity: scoreTier3(sidecar.annotation, candidate.action, stateMetadata),
      }
    }

    return { tierReached: 2, opClass, elementIdentity: scoredIdentity('miss', 2) }
  }

  if (sidecar.annotation !== undefined) {
    return {
      tierReached: 3,
      opClass,
      elementIdentity: scoreTier3(sidecar.annotation, candidate.action, stateMetadata),
    }
  }

  return {
    tierReached: 1,
    opClass,
    elementIdentity: { kind: 'unscorable', cause: 'no-gold-evidence' },
  }
}
