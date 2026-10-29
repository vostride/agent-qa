import { describe, expect, it } from 'vitest'

import {
  A11yEvidenceDocumentSchema,
  AnalysisVersionError,
  AriaEvidenceDocumentSchema,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  CURRENT_BUS_SCHEMA_VERSION,
  ConsoleEvidenceDocumentSchema,
  LosslessServedBriefError,
  NetworkEvidenceDocumentSchema,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
  ServedRetrievalTraceV1Schema,
  VariablesEvidenceDocumentSchema,
  computeBriefDigest,
  guardLosslessServedBrief,
  guardRunAnalysisArtifact,
  sha256hex,
} from '../index'
import type { LosslessServedBrief } from '../index'

function losslessBrief(stamp: number): LosslessServedBrief {
  const contextTier = 'Current test: checkout'
  const volatileTier = 'Current date: 2026-07-24'
  const brief = {
    scope: { tier: 'test', key: 'checkout-flow' },
    asOfBuild: 7,
    budget: 3,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: '',
    proof: {
      schemaVersion: stamp,
      completeness: 'lossless',
      recordCap: 8,
      combinedBudget: 512,
      admissionEvents: [],
      promptTurns: [{
        ordinal: 0,
        turnOrdinal: 0,
        runDate: '2026-07-24',
        policyL0: '',
        learnedL1: '',
        learnedL2: '',
        contextTier,
        volatileTier,
        policyDigest: sha256hex(''),
        contextTierDigest: sha256hex(contextTier),
        volatileTierDigest: sha256hex(volatileTier),
      }],
    },
  } as unknown as LosslessServedBrief
  return { ...brief, briefDigest: computeBriefDigest(brief) }
}

function trace(stamp: number): unknown {
  return {
    schemaVersion: stamp,
    servedLines: [{ recordId: 'rec-checkout', leg: 'lexical', rank: 1, score: 0.5 }],
    truncated: [],
  }
}

const evidenceDocuments = [
  ['console', ConsoleEvidenceDocumentSchema, { kind: 'console', records: [] }],
  ['network', NetworkEvidenceDocumentSchema, { kind: 'network', records: [] }],
  ['a11y', A11yEvidenceDocumentSchema, { kind: 'a11y', records: [] }],
  ['aria', AriaEvidenceDocumentSchema, { kind: 'aria', tree: '- main' }],
  ['variables', VariablesEvidenceDocumentSchema, { kind: 'variables', records: {} }],
] as const

function analysis(stamp: number) {
  return { schemaVersion: stamp, runId: 'run-stamps', verdicts: [], parts: [] }
}

describe('run evidence stamps', () => {
  it('stamps every run evidence format 2', () => {
    expect(SERVED_BRIEF_PROOF_SCHEMA_VERSION).toBe(2)
    expect(RETRIEVAL_TRACE_SCHEMA_VERSION).toBe(2)
    expect(RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION).toBe(2)
    expect(CURRENT_ANALYSIS_SCHEMA_VERSION).toBe(2)
    expect(CURRENT_BUS_SCHEMA_VERSION).toBe(2)
    expect(RUN_ARTIFACT_SCHEMA_VERSION).toBe(2)
  })

  it('reads a lossless proof at its schema version', () => {
    const brief = losslessBrief(SERVED_BRIEF_PROOF_SCHEMA_VERSION)
    expect(guardLosslessServedBrief(brief)).toEqual(brief)
  })

  it.each([1, 3])('refuses a lossless proof stamped %i', (stamp) => {
    const brief = losslessBrief(stamp)
    let caught: unknown
    try {
      guardLosslessServedBrief(brief)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LosslessServedBriefError)
    expect((caught as LosslessServedBriefError).paths).toContain('proof.schemaVersion')
  })

  it('reads a retrieval trace at its schema version', () => {
    expect(ServedRetrievalTraceV1Schema.parse(trace(RETRIEVAL_TRACE_SCHEMA_VERSION)))
      .toEqual(trace(RETRIEVAL_TRACE_SCHEMA_VERSION))
  })

  it.each([1, 3])('refuses a retrieval trace stamped %i', (stamp) => {
    expect(ServedRetrievalTraceV1Schema.safeParse(trace(stamp)).success).toBe(false)
  })

  it.each(evidenceDocuments)(
    'reads a %s evidence document at its schema version',
    (_kind, schema, body) => {
      const document = { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, ...body }
      expect(schema.parse(document)).toEqual(document)
    },
  )

  it.each(evidenceDocuments.flatMap(([kind, schema, body]) =>
    [1, 3].map((stamp) => [kind, stamp, schema, body] as const),
  ))('refuses a %s evidence document stamped %i', (_kind, stamp, schema, body) => {
    expect(schema.safeParse({ schemaVersion: stamp, ...body }).success).toBe(false)
  })

  it('reads a run analysis at its schema version', () => {
    const artifact = analysis(CURRENT_ANALYSIS_SCHEMA_VERSION)
    expect(guardRunAnalysisArtifact(artifact)).toBe(artifact)
  })

  it.each([1, 3])('refuses a run analysis stamped %i', (stamp) => {
    expect(() => guardRunAnalysisArtifact(analysis(stamp))).toThrow(AnalysisVersionError)
  })
})
