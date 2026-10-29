// Render-time pure clustering over the ONE fingerprint vocabulary (Phase 389, D-13..D-16).
//
// The ANLZ-04 story at the unit level: 40 red tests sharing one anchor and one class are ONE
// problem — exactly one cluster, count 40, forty member refs. Everything here is a total,
// deterministic pure function of (resolved verdicts, handoff): nothing persisted, no ports,
// no identity minted (D-16 — the fingerprint VALUE is the only key a cluster carries;
// a cluster or verdict has no short-ID and no `agentqa://` address).

import { canonicalJson, resolveRunVerdicts } from '@vostride/agent-qa-schema'
import type { Verdict } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { buildSyntheticHandoff } from '../../jobs/__tests__/fixtures/synthetic-handoff.js'
import { clusterVerdicts } from '../cluster.js'

function appBug(perTest: number, confidence: number): Verdict {
  return {
    class: 'app_bug',
    producer: 'analyze-run',
    confidence,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'the submit button never enabled',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
  }
}

describe('clusterVerdicts — one cluster per anchor and failure class', () => {
  it('folds 40 failures sharing one anchor and one class into ONE cluster of count 40', () => {
    const handoff = buildSyntheticHandoff({ failureCount: 40 })
    const resolved = resolveRunVerdicts(undefined, handoff)

    const clusters = clusterVerdicts(resolved, handoff)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.count).toBe(40)
    expect(clusters[0]!.members).toHaveLength(40)
    // Members ride testIndex order, and each ref names the real member test.
    expect(clusters[0]!.members.map((member) => member.testIndex))
      .toEqual([...Array.from({ length: 40 }, (_, index) => index)])
    expect(clusters[0]!.members[0]!.testId).toBe('t_failed_0')
    expect(clusters[0]!.members[39]!.testId).toBe('t_failed_39')
  })

  it('keeps the same anchor under two classes as TWO clusters — adjacency, not identity', () => {
    // Failures 0/1 stay on the unknown floor; 2/3 carry an authored app_bug — one anchor,
    // two classes, two facts (the fingerprint recipe's `::class` suffix earning its keep).
    const handoff = buildSyntheticHandoff({
      failureCount: 4,
      rootCauseFor: (index) => (index >= 2 ? appBug(index, 0.8) : undefined),
    })
    const resolved = resolveRunVerdicts(undefined, handoff)

    const clusters = clusterVerdicts(resolved, handoff)

    expect(clusters).toHaveLength(2)
    expect(clusters.map((cluster) => cluster.count)).toEqual([2, 2])
    const byClassSuffix = clusters.map((cluster) => cluster.fingerprint.split('::')[1])
    expect(byClassSuffix.sort()).toEqual(['app_bug', 'unknown'])
    // Equal counts tie-break on fingerprint lexicographic order, byte-wise.
    expect([...clusters.map((c) => c.fingerprint)].sort()).toEqual(
      clusters.map((c) => c.fingerprint),
    )
  })

  it('keys anchorless (step-less) failures on the error-signature fallback, apart from stepped', () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2, steplessFailureCount: 3 })
    const resolved = resolveRunVerdicts(undefined, handoff)

    const clusters = clusterVerdicts(resolved, handoff)

    expect(clusters).toHaveLength(2)
    // Occurrence count descending: the three step-less failures lead.
    expect(clusters[0]!.count).toBe(3)
    expect(clusters[0]!.fingerprint).toContain('"t":"error"')
    expect(clusters[1]!.count).toBe(2)
    expect(clusters[1]!.fingerprint).toContain('"t":"el"')
  })

  it('answers an empty resolved-verdict list with an empty cluster list, never a throw', () => {
    const handoff = buildSyntheticHandoff({ failureCount: 0, passedCount: 3 })

    expect(clusterVerdicts([], handoff)).toEqual([])
    expect(clusterVerdicts(resolveRunVerdicts(undefined, handoff), handoff)).toEqual([])
  })
})

describe('representative selection', () => {
  it('selects the highest-confidence member as representative', () => {
    const handoff = buildSyntheticHandoff({
      failureCount: 2,
      rootCauseFor: (index) => appBug(index, index === 0 ? 0.4 : 0.9),
    })
    const resolved = resolveRunVerdicts(undefined, handoff)

    const clusters = clusterVerdicts(resolved, handoff)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.representative).toEqual({ testIndex: 1 })
  })

  it('breaks an equal-confidence tie to the LOWEST testIndex, deterministically', () => {
    const handoff = buildSyntheticHandoff({
      failureCount: 3,
      rootCauseFor: (index) => appBug(index, 0.5),
    })
    const resolved = resolveRunVerdicts(undefined, handoff)

    const clusters = clusterVerdicts(resolved, handoff)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.representative).toEqual({ testIndex: 0 })
  })
})

describe('deterministic presentation', () => {
  it('produces byte-identical output from shuffled input verdicts', () => {
    const handoff = buildSyntheticHandoff({
      failureCount: 6,
      steplessFailureCount: 2,
      rootCauseFor: (index) => (index % 2 === 0 ? appBug(index, 0.7) : undefined),
    })
    const resolved = resolveRunVerdicts(undefined, handoff)
    const shuffled = [
      resolved[5]!, resolved[2]!, resolved[7]!, resolved[0]!,
      resolved[6]!, resolved[3]!, resolved[1]!, resolved[4]!,
    ]

    expect(canonicalJson(clusterVerdicts(shuffled, handoff)))
      .toBe(canonicalJson(clusterVerdicts(resolved, handoff)))
  })

  it('carries fingerprint value, count and member refs ONLY — no minted identity', () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2 })
    const clusters = clusterVerdicts(resolveRunVerdicts(undefined, handoff), handoff)

    const cluster = clusters[0]!
    expect(Object.keys(cluster).sort()).toEqual([
      'count', 'fingerprint', 'members', 'representative',
    ])
    expect(Object.keys(cluster.representative).sort()).toEqual(['testIndex'])
    expect(Object.keys(cluster.members[0]!).sort()).toEqual(['testId', 'testIndex'])
    // No short-ID, no address — the fingerprint value is the only key.
    expect(canonicalJson(clusters)).not.toContain('agentqa://')
  })
})
