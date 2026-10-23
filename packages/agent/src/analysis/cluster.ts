// Render-time pure clustering over resolved verdicts (Phase 389, D-13..D-16).
//
// Called inside the `analysis.get` op and nowhere else persistent (D-14): CLI, run page and
// chat get byte-identical clusters because there is nothing here to go stale — no store, no
// port, no cache. Groups key on the ONE exported fingerprint vocabulary (`failureFingerprint`,
// D-13) over the ONE exported input rule (`failingStepOf`/`errorTextOf`, hoisted into schema by
// 390 plan 02), so 390's recurrence window and this presentation cannot disagree about what "the
// same failure" means — not by convention, but because there is a single spelling of each.
//
// D-16 — clusters mint NO identity. A cluster carries the fingerprint VALUE, its
// occurrence count and member refs, and nothing else:
// a cluster or verdict has no short-ID and no `agentqa://` address.
// 2026-09-02 (Phase 410): the sixth entity kind left with the Issue-slot cleanup.

import {
  errorTextOf,
  exercisedAnchors,
  failingStepOf,
  failureFingerprint,
} from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, Verdict } from '@vostride/agent-qa-schema'

/** One member ref: the join keys a surface needs to expand a cluster, nothing more. */
export interface AnalysisClusterMember {
  testIndex: number
  testId: string
}

/** Fingerprint value, count, member refs, representative ref — the whole DTO (D-16). */
export interface AnalysisCluster {
  fingerprint: string
  count: number
  /** Ordered by `testIndex`, ascending — stable across calls and processes. */
  members: AnalysisClusterMember[]
  /** The highest-confidence member; equal confidence breaks to the LOWEST testIndex. */
  representative: { testIndex: number }
}

interface GroupedMember extends AnalysisClusterMember {
  confidence: number
}

/**
 * Group resolved verdicts by failure fingerprint (D-14) — a total, deterministic pure
 * function. Identical fingerprints merge; the same anchor under two classes stays two
 * clusters (the recipe's `::class` suffix). Output order: occurrence count descending,
 * then fingerprint lexicographic byte order; members by testIndex ascending. Empty input
 * answers an empty list, never a throw.
 */
export function clusterVerdicts(
  resolvedVerdicts: readonly Verdict[],
  handoff: CompletedRunHandoff,
): AnalysisCluster[] {
  const groups = new Map<string, GroupedMember[]>()
  for (const verdict of resolvedVerdicts) {
    const test = handoff.tests.find((candidate) => candidate.testIndex === verdict.perTest)
    // A verdict whose perTest names no member test still keys deterministically: no anchors,
    // empty error text — the fingerprint recipe is total over that too.
    const step = test === undefined ? undefined : failingStepOf(test)
    const anchors = step === undefined ? [] : exercisedAnchors(step)
    const fingerprint = failureFingerprint(
      { anchors, errorText: test === undefined ? '' : errorTextOf(step, test) },
      verdict.class,
    )
    const members = groups.get(fingerprint) ?? []
    members.push({
      testIndex: verdict.perTest,
      testId: test?.testId ?? '',
      confidence: verdict.confidence,
    })
    groups.set(fingerprint, members)
  }

  return [...groups.entries()]
    .map(([fingerprint, grouped]) => {
      const members = [...grouped].sort((left, right) => left.testIndex - right.testIndex)
      // Walking testIndex-ascending with a STRICT > keeps the first (lowest testIndex)
      // member on equal confidence — the D-15 tie-break, deterministic by construction.
      let representative = members[0] as GroupedMember
      for (const member of members) {
        if (member.confidence > representative.confidence) representative = member
      }
      return {
        fingerprint,
        count: members.length,
        members: members.map(({ testIndex, testId }) => ({ testIndex, testId })),
        representative: { testIndex: representative.testIndex },
      }
    })
    .sort((left, right) => (
      right.count - left.count
      || (left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0)
    ))
}
