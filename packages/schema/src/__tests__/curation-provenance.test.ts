import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BUNDLE_SCHEMA_VERSION,
  BundleProvenanceSchema,
  BundleRelationsSchema,
  deriveEvidenceToken,
} from '../index'
import type {
  CurationAuthorship,
  CurationAuthorshipPath,
  Delta,
  DeltaEnvelope,
  OriginStage,
} from '../index'

const scope = { tier: 'product', key: 'checkout' } as const

const authorshipPathLabels: Record<CurationAuthorshipPath, string> = {
  llm: 'model-authored',
  'llm-repaired': 'model-authored after repair',
  'deterministic-fallback': 'code-authored fallback',
}

describe('curation provenance contracts', () => {
  it('keeps authorship optional while accepting the closed authorship stamp', () => {
    const unstampedEnvelope: DeltaEnvelope = {
      origin: 'agent',
      scope,
      citedIds: [],
    }

    const stampedDelta: Delta = {
      kind: 'Noop',
      origin: 'agent',
      scope,
      citedIds: [],
      authorship: {
        path: 'deterministic-fallback',
        model: {
          id: 'fallback-author',
          family: 'deterministic',
          fingerprint: 'v1',
        },
        executionContext: 'ci',
      },
    }

    expect(unstampedEnvelope).not.toHaveProperty('authorship')
    expect(stampedDelta.authorship).toEqual({
      path: 'deterministic-fallback',
      model: {
        id: 'fallback-author',
        family: 'deterministic',
        fingerprint: 'v1',
      },
      executionContext: 'ci',
    })
    expect(authorshipPathLabels).toEqual({
      llm: 'model-authored',
      'llm-repaired': 'model-authored after repair',
      'deterministic-fallback': 'code-authored fallback',
    })
    expectTypeOf(stampedDelta.authorship).toMatchTypeOf<DeltaEnvelope['authorship']>()
    expectTypeOf(stampedDelta.authorship).toMatchTypeOf<CurationAuthorship | undefined>()
  })

  it('closes OriginStage around the live drainer producer', () => {
    const stage: OriginStage = 'run-curation'

    expect(stage).toBe('run-curation')

    // @ts-expect-error OriginStage is schema-owned and rejects arbitrary producer labels.
    const unsupportedStage: OriginStage = 'arbitrary-stage'
    void unsupportedStage
  })

  it('accepts propose-only supersession relations and rejects unknown relation types', () => {
    const proposedSupersession = {
      type: 'proposed-supersession-of',
      targetId: 'x',
      addedAtOrdinal: 3,
      curationJobId: 'j1',
    } as const

    expect(
      BundleRelationsSchema.parse({
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        relations: [proposedSupersession],
      }).relations,
    ).toEqual([proposedSupersession])
    expect(
      BundleRelationsSchema.safeParse({
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        relations: [{ ...proposedSupersession, type: 'unknown-relation' }],
      }).success,
    ).toBe(false)
  })

  it('parses optional run-linked curation provenance without a schema-version bump', () => {
    const runLinkedProvenance = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      mode: 'run-linked',
      originClass: 'agent-observed',
      runId: 'run-1',
      testId: 'checkout',
      stepIndex: 2,
    } as const
    const curationProvenance = {
      ...runLinkedProvenance,
      curationJobId: 'curation-job-1',
      sourceBuildOrdinal: 3,
      authorship: {
        path: 'llm-repaired',
        model: {
          id: 'curator-model',
          family: 'curator-family',
          fingerprint: 'curator-v1',
        },
        executionContext: 'local-headless',
      },
      needsEnrichment: true,
      withheld: true,
    } as const

    expect(BUNDLE_SCHEMA_VERSION).toBe(2)
    expect(BundleProvenanceSchema.parse(runLinkedProvenance)).toEqual(runLinkedProvenance)
    expect(BundleProvenanceSchema.parse(curationProvenance)).toEqual(curationProvenance)
    expect(
      BundleProvenanceSchema.safeParse({
        ...curationProvenance,
        authorship: { ...curationProvenance.authorship, path: 'operator-authored' },
      }).success,
    ).toBe(false)
    expect(deriveEvidenceToken).toBeTypeOf('function')
  })
})
