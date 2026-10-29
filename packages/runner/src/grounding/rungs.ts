// Records one attempt per rung run and appends `visual:skipped` when no visual rung ran.

import { matchDescriptor } from './matcher.js'
import type { DescriptorInput, MatchResult, PriorContext } from './matcher.js'
import type { ElementInfo, GroundingAttempt, Ref } from '@vostride/agent-qa-schema'

// The ref rung validates `committedRef`; the tree-search and visual rungs resolve `descriptor`.
export interface RungRequest {
  descriptor?: DescriptorInput
  committedRef?: Ref
  elements: readonly ElementInfo[]
  refMap: Record<Ref, unknown>
  prior?: PriorContext
}

/** A rung's outcome mirrors the matcher's discriminated result kinds. */
export type RungOutcome = MatchResult

/** One rung of the ladder: a stage tag + a pure run() over the uniform request. */
export interface GroundingRung {
  stage: GroundingAttempt['stage']
  run(req: RungRequest): RungOutcome
}

/**
 * Ref-validation rung (stage 'ref'): resolves when a committed ref is still present in
 * the fresh refMap, no-match otherwise. When only a descriptor is supplied it reports
 * no-match so the ladder falls through to tree-search.
 */
export const refValidateRung: GroundingRung = {
  stage: 'ref',
  run(req) {
    if (req.committedRef !== undefined && req.committedRef in req.refMap) {
      return { kind: 'resolved', ref: req.committedRef }
    }
    return { kind: 'no-match' }
  },
}

/**
 * Tree-search rung (stage 'tree-search'): delegates to the shared matchDescriptor over
 * the fresh observation. No descriptor ⇒ no-match (nothing to search for).
 */
export const treeSearchRung: GroundingRung = {
  stage: 'tree-search',
  run(req) {
    if (req.descriptor === undefined) return { kind: 'no-match' }
    return matchDescriptor({ descriptor: req.descriptor, elements: req.elements, prior: req.prior })
  },
}

/** Capability options for ladder assembly. */
export interface LadderOptions {
  /** Vision capability present — required for a visual rung to be appended. */
  vision?: boolean
  /** Caller-supplied extra rungs; only stage 'visual' entries are appended, and only under vision. */
  extraRungs?: GroundingRung[]
}

// A supplied visual rung is appended only when `options.vision` is true.
export function assembleLadder(options: LadderOptions = {}): GroundingRung[] {
  const ladder: GroundingRung[] = [refValidateRung, treeSearchRung]
  if (options.vision && options.extraRungs) {
    for (const rung of options.extraRungs) {
      if (rung.stage === 'visual') ladder.push(rung)
    }
  }
  return ladder
}

/** The ladder run result: a resolution, an ambiguity, a rejection, plus the attempt trail. */
export interface RunLadderResult {
  resolvedRef?: Ref
  ambiguous?: Ref[]
  rejected?: 'name-missing' | 'near-unsupported'
  attempts: GroundingAttempt[]
}

// Rejection short-circuits, the first resolution stops, and ambiguity records a no-match attempt.
export function runLadder(rungs: readonly GroundingRung[], req: RungRequest): RunLadderResult {
  const attempts: GroundingAttempt[] = []
  let sawVisual = false
  let ambiguous: Ref[] | undefined

  for (const rung of rungs) {
    if (rung.stage === 'visual') sawVisual = true
    const outcome = rung.run(req)

    if (outcome.kind === 'rejected') {
      return { rejected: outcome.reason, attempts }
    }
    if (outcome.kind === 'resolved') {
      attempts.push({ stage: rung.stage, outcome: 'resolved', resolvedRef: outcome.ref })
      return { resolvedRef: outcome.ref, attempts }
    }

    attempts.push({ stage: rung.stage, outcome: 'no-match' })
    if (outcome.kind === 'ambiguous') ambiguous = outcome.candidates
  }

  if (!sawVisual) attempts.push({ stage: 'visual', outcome: 'skipped' })
  return ambiguous !== undefined ? { ambiguous, attempts } : { attempts }
}
