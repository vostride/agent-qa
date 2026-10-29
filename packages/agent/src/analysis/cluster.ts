// No store, port or cache, so every surface gets the same clusters; a cluster mints no identity.

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

/** Fingerprint value, count, member refs, representative ref — the whole DTO. */
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

// Count descending, then fingerprint byte order; one anchor under two classes stays two clusters.
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
      // A strict `>` keeps the lowest testIndex member on equal confidence.
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
