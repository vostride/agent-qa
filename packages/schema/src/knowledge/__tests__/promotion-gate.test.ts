import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { asEvidenceToken } from '../../ids/record-id'
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, distilledObservationSchema } from '../distilled-observation'
import { GATE_RECEIPT_SCHEMA_VERSION, stampReceiptDigest, type GateReceipt, type GateVerdict } from '../gate-receipt'
import {
  evaluatePromotionGate,
  type PromotionGateHoldReason,
  type PromotionGateInput,
} from '../promotion-gate'

function receipt(
  gate: 1 | 3, verdict: GateVerdict, producedAtOrdinal = 5,
  overrides: { corpusDigest?: string } = {},
): GateReceipt {
  const core = {
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION as typeof GATE_RECEIPT_SCHEMA_VERSION,
    candidateId: 'candidate', verdict, producedAtOrdinal,
    producedBy: { opId: 'gate-test' },
  }
  const corpusDigest = overrides.corpusDigest ?? 'c'.repeat(64)
  if (gate === 3) return stampReceiptDigest({ ...core, gate, runId: 'run', mark: 'confirmed-bug' })
  const score = { baseline: 0.5, candidate: 0.8, delta: 0.3, floor: 0.1, n: 10 }
  return stampReceiptDigest({
    ...core, gate,
    perAxisScore: { headline: score, elementIdentity: score, value: score, opClass: score,
      sideEffect: score, loop: score },
    corpusVersion: { corpusDigest, partitionVersion: 2, gateSetSize: 63,
      excludedCount: 0, minimumGateSet: 63 },
    samples: { k: 1, seeds: [1], seedHonored: true, modelCalls: 0 }, crossCheck: 'held',
  })
}

const submitAnchor = {
  t: 'el' as const,
  role: 'button',
  name: 'submit order',
  ordinal: 0,
}

function factInput(overrides: Partial<PromotionGateInput> = {}): PromotionGateInput {
  return {
    kind: 'fact',
    subtype: 'selector',
    status: 'candidate',
    validityOpen: true,
    anchors: [submitAnchor, { t: 'platform', platform: 'web' }],
    originClass: 'agent-verified',
    withheld: false,
    needsEnrichment: false,
    evidenceIncomplete: false,
    distilledObservations: [
      { element: { naturalKey: 'button:submit order:0' } },
    ],
    confirmedOutcomeEvidenceTokens: [asEvidenceToken('confirmed-submit-order')],
    hasUserDeprecateInLineage: false,
    memoryOffForAnchorGroup: false,
    ...overrides,
  }
}

it('holds a learned policy record as kind-excluded even with an accepted policy receipt', () => {
  const approval = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId: 'candidate',
    verdict: 'pass', producedAtOrdinal: 5, producedBy: { opId: 'knowledge.proposal.apply' },
    policyApproval: { proposalId: 'kp_policy', recordId: 'candidate' } } as const)
  expect(evaluatePromotionGate({ ...factInput(), kind: 'policy', gateReceipts: [approval] }))
    .toMatchObject({ verdict: 'hold', reason: 'kind-excluded' })
})

function cautionInput(overrides: Partial<PromotionGateInput> = {}): PromotionGateInput {
  return {
    kind: 'caution',
    status: 'candidate',
    validityOpen: true,
    anchors: [{ t: 'error', message: 'checkout timed out' }],
    originClass: 'agent-verified',
    withheld: false,
    needsEnrichment: false,
    evidenceIncomplete: false,
    distilledObservations: [
      {
        error: {
          naturalKey: 'checkout timed out',
          rootCauseClass: 'environment',
        },
      },
    ],
    confirmedOutcomeEvidenceTokens: [asEvidenceToken('confirmed-checkout-caution')],
    hasUserDeprecateInLineage: false,
    memoryOffForAnchorGroup: false,
    ...overrides,
  }
}

describe('evaluatePromotionGate fact evidence', () => {
  it('promotes a candidate fact with an open window and matching element evidence', () => {
    expect(evaluatePromotionGate(factInput())).toEqual({ verdict: 'promote', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] })
  })

  it('promotes a navigational fact whose page primary is backed by a matching element', () => {
    expect(evaluatePromotionGate(factInput({
      subtype: 'navigational',
      anchors: [
        { t: 'page', route: '/confirmation' },
        submitAnchor,
        { t: 'platform', platform: 'web' },
      ],
    }))).toEqual({ verdict: 'promote', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] })
  })

  it('holds a fact until a surviving confirmed outcome supplies evidence', () => {
    expect(evaluatePromotionGate(factInput({ confirmedOutcomeEvidenceTokens: [] }))).toEqual({
      verdict: 'hold',
      reason: 'no-confirmed-evidence',
    })
  })

  it('holds ambiguous multi-element evidence instead of accepting one matching element', () => {
    expect(evaluatePromotionGate(factInput({
      distilledObservations: [
        { element: { naturalKey: 'button:submit order:0' } },
        { element: { naturalKey: 'button:cancel order:1' } },
      ],
    }))).toEqual({
      verdict: 'hold',
      reason: 'no-element-observation',
    })
  })

  it('keys on evidence rather than authorship path while holding bare fallback Adds', () => {
    expect(evaluatePromotionGate(factInput({ originClass: 'agent-observed' })))
      .toEqual({ verdict: 'promote', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] })
    expect(evaluatePromotionGate(factInput({
      originClass: 'agent-observed',
      needsEnrichment: true,
    }))).toEqual({ verdict: 'hold', reason: 'needs-enrichment' })
  })
})

describe('evaluatePromotionGate caution evidence', () => {
  it('promotes only a caution with a typed learnable root-cause class', () => {
    expect(evaluatePromotionGate(cautionInput())).toEqual({ verdict: 'promote', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] })

    expect(evaluatePromotionGate(cautionInput({
      distilledObservations: [
        { error: { naturalKey: 'environment: checkout timed out' } },
      ],
    }))).toEqual({ verdict: 'hold', reason: 'missing-root-cause' })
  })

  it('round-trips rootCauseClass as additive identity-bearing observation evidence', () => {
    const observation = {
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
      step: { naturalKey: 'checkout', ordinal: 0 },
      error: {
        naturalKey: 'checkout timed out',
        rootCauseClass: 'timeout' as const,
      },
      observedAtOrdinal: 42,
    }

    expect(distilledObservationSchema.parse(observation)).toEqual(observation)
    expect(distilledObservationSchema.safeParse({
      ...observation,
      error: { ...observation.error, rootCauseClass: 'app-bug' },
    }).success).toBe(false)
  })
})

describe('evaluatePromotionGate exclusion walls', () => {
  it.each(['procedure', 'policy', 'unknown'] as const)(
    'holds kind %s before considering otherwise-complete evidence',
    (kind) => {
      expect(evaluatePromotionGate(factInput({ kind }))).toEqual({
        verdict: 'hold',
        reason: 'kind-excluded',
      })
    },
  )

  const exclusionCases: ReadonlyArray<[
    name: string,
    override: Partial<PromotionGateInput>,
    reason: PromotionGateHoldReason,
  ]> = [
    ['non-candidate status', { status: 'active' }, 'not-candidate'],
    ['closed validity window', { validityOpen: false }, 'window-closed'],
    ['withheld provenance', { withheld: true }, 'withheld'],
    ['needs-enrichment provenance', { needsEnrichment: true }, 'needs-enrichment'],
    ['incomplete evidence', { evidenceIncomplete: true }, 'evidence-incomplete'],
    ['memory-off anchor group', { memoryOffForAnchorGroup: true }, 'memory-off-anchor'],
    ['user-deprecated lineage', { hasUserDeprecateInLineage: true }, 'user-deprecated'],
  ]

  it.each(exclusionCases)('holds %s with its typed reason', (_name, override, reason) => {
    expect(evaluatePromotionGate(factInput(override))).toEqual({ verdict: 'hold', reason })
  })

  it('holds bridge-style facts whose synthetic payload has no element observation', () => {
    expect(evaluatePromotionGate(factInput({ distilledObservations: [] }))).toEqual({
      verdict: 'hold',
      reason: 'no-element-observation',
    })
  })
})

describe('promotion gate architecture', () => {
  it('has no model, port, provider, or adapter import path', () => {
    const source = readFileSync(new URL('../promotion-gate.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(
      /from\s+['"][^'"]*(?:model|port|provider|adapter)[^'"]*['"]/i,
    )
  })
})

describe('evaluatePromotionGate receipt paths', () => {
  const floor = { verdict: 'promote', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] }
  const withReceipts = (gateReceipts: readonly GateReceipt[],
    overrides: Partial<PromotionGateInput> = {}) => evaluatePromotionGate(factInput({
      gateReceipts, ...overrides,
    }))

  it('promotes user-sovereign on a standing Gate-3 pass without any floor evidence', () => {
    const g3 = receipt(3, 'pass')
    for (const build of [factInput, cautionInput]) {
      expect(evaluatePromotionGate(build({ gateReceipts: [g3],
        confirmedOutcomeEvidenceTokens: [], distilledObservations: [], withheld: true,
        needsEnrichment: true, evidenceIncomplete: true, memoryOffForAnchorGroup: true,
        hasUserDeprecateInLineage: true,
      }))).toEqual({ verdict: 'promote', promotionPath: 'user-sovereign',
        citedReceiptDigests: [g3.receiptDigest] })
    }
  })

  it('promotes user-sovereign beside a Gate-1 receipt on another corpus', () => {
    const g3 = receipt(3, 'pass')
    expect(withReceipts([receipt(1, 'pass', 10, { corpusDigest: 'd'.repeat(64) }), g3]))
      .toEqual({ verdict: 'promote', promotionPath: 'user-sovereign',
        citedReceiptDigests: [g3.receiptDigest] })
  })

  it('reads the standing Gate-3 instead of an older sovereign pass', () => {
    expect(withReceipts([receipt(3, 'pass', 4), receipt(3, 'fail', 5)])).toEqual(floor)
    expect(withReceipts([receipt(3, 'pass', 5), receipt(3, 'abstain', 5)])).toEqual(floor)
    expect(withReceipts([receipt(3, 'pass', 4), receipt(3, 'fail', 5)],
      { confirmedOutcomeEvidenceTokens: [] }))
      .toEqual({ verdict: 'hold', reason: 'no-confirmed-evidence' })
  })

  it.each(['pass', 'fail', 'abstain'] as const)(
    'decides by the floor alone beside a Gate-1 %s receipt',
    (verdict) => {
      const g1 = receipt(1, verdict)
      expect(withReceipts([g1])).toEqual(floor)
      expect(evaluatePromotionGate(cautionInput({ gateReceipts: [g1] }))).toEqual(floor)
      expect(withReceipts([g1], { distilledObservations: [] }))
        .toEqual({ verdict: 'hold', reason: 'no-element-observation' })
      expect(withReceipts([g1], { confirmedOutcomeEvidenceTokens: [] }))
        .toEqual({ verdict: 'hold', reason: 'no-confirmed-evidence' })
    },
  )

  it('keeps kind, status and window precedence over a sovereign pass', () => {
    for (const [override, reason] of [
      [{ kind: 'procedure' }, 'kind-excluded'], [{ kind: 'policy' }, 'kind-excluded'],
      [{ status: 'active' }, 'not-candidate'], [{ validityOpen: false }, 'window-closed'],
    ] as const) {
      expect(withReceipts([receipt(1, 'pass'), receipt(3, 'pass')], override))
        .toEqual({ verdict: 'hold', reason })
    }
  })
})
