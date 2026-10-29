// The rung-composed grounding ladder (Phase 357, GROUND-02 · D-01/D-02/D-03, Q3).
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp, no
// core/model/adapter package imports — imports only the sibling matcher + schema types.
//
// The ladder is a uniform request/result contract over ordered rungs. Default assembly
// is [refValidateRung, treeSearchRung] (D-01: no visual rung ships in M1); a visual rung
// is appended by assembleLadder ONLY when a rung is supplied AND vision capability is
// present (Q3 resolved as recommended — injected capability options, the negotiation
// seam ships without a body). runLadder records one schema §A8 GroundingAttempt per rung
// run, stops at the first resolution, and appends {stage:'visual', outcome:'skipped'}
// when the ladder exhausts without a visual rung having run (D-02 — the
// how-often-would-visual-have-fired denominator).

import { matchDescriptor } from './matcher.js'
import type { DescriptorInput, MatchResult, PriorContext } from './matcher.js'
import type { ElementInfo, GroundingAttempt, Ref } from '@vostride/agent-qa-schema'

/**
 * The uniform per-rung request. A rung either validates a `committedRef` against the
 * fresh `refMap` (the ref rung) or resolves a `descriptor` against the fresh `elements`
 * (the tree-search / visual rungs). `prior` carries the optional D-10 hierarchy context.
 */
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

/** Capability options for ladder assembly (the Q3 negotiation seam). */
export interface LadderOptions {
  /** Vision capability present — required for a visual rung to be appended. */
  vision?: boolean
  /** Caller-supplied extra rungs; only stage 'visual' entries are appended, and only under vision. */
  extraRungs?: GroundingRung[]
}

/**
 * Assemble the ladder: default [refValidateRung, treeSearchRung]. A supplied
 * visual rung is appended ONLY when options.vision is true — the capability-gated
 * assembly resolving research Q3. No visual rung is registered in M1.
 */
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

/**
 * Run the rungs in order, recording one §A8 attempt per rung. Rejection short-circuits;
 * the first resolution stops the ladder; ambiguity is recorded as a no-match attempt and
 * surfaced on the result. When the ladder exhausts without a visual rung having run, a
 * {stage:'visual', outcome:'skipped'} attempt is appended.
 */
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
