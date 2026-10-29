import { describe, expect, expectTypeOf, it } from 'vitest'

import { VersionGuardError } from '../../versioning/create-version-guard'
import {
  ArtifactsIndexSchema,
  BUNDLE_SCHEMA_VERSION,
  BundleManifestSchema,
  BundleProvenanceSchema,
  BundleRelationsSchema,
  computeMutableStateHash,
  guardArtifactsIndex,
  guardBundleManifest,
  guardBundleProvenance,
  guardBundleRelations,
  type MutableStateHashInput,
} from '../bundle-files'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const DIGEST_C = 'c'.repeat(64)
const DIGEST_D = 'd'.repeat(64)

const manifest = {
  schemaVersion: BUNDLE_SCHEMA_VERSION,
  id: 'fact-el-sign-in-button-0123456789abcdef',
  identityHash: DIGEST_A,
  identityCore: {
    kind: 'fact' as const,
    subtype: 'selector' as const,
    primaryAnchor: { t: 'el' as const, role: 'button', name: 'sign in' },
    scope: { tier: 'product' as const, key: 'storefront' },
    discriminantKey: '{"kind":"fact"}',
  },
  embeddingInput: 'Sign-in button\n\nClicking submits credentials.',
  contentHashes: {
    'record.md': DIGEST_B,
    'evidence/outcomes.jsonl': DIGEST_C,
  },
  mutableStateHash: DIGEST_D,
  evidenceIncomplete: false,
  complete: true,
  createdAtOrdinal: 42,
  originClass: 'agent-verified' as const,
}

const provenance = {
  schemaVersion: BUNDLE_SCHEMA_VERSION,
  mode: 'run-linked' as const,
  originClass: 'agent-verified' as const,
  runId: 'run-a',
  testId: 'test-a',
  stepIndex: 3,
}

const relations = {
  schemaVersion: BUNDLE_SCHEMA_VERSION,
  relations: [{
    type: 'renamed-from' as const,
    targetId: 'fact-el-old-name-0123456789abcdef',
    addedAtOrdinal: 43,
    curationJobId: 'curation-a',
  }],
}

const artifactsIndex = {
  schemaVersion: BUNDLE_SCHEMA_VERSION,
  artifacts: [{
    id: 'screenshot-a',
    sha: DIGEST_A,
    bytes: 128,
    stepIndex: 3,
    relPath: `artifacts/${DIGEST_A}`,
    role: 'pre-action-screen',
    originalName: 'screen.png',
  }],
}

describe('committed bundle-file schemas', () => {
  it.each([
    ['manifest', BundleManifestSchema, manifest],
    ['provenance', BundleProvenanceSchema, provenance],
    ['relations', BundleRelationsSchema, relations],
    ['artifacts index', ArtifactsIndexSchema, artifactsIndex],
  ] as const)('round-trips a valid %s fixture', (_name, schema, fixture) => {
    expect(schema.parse(fixture)).toEqual(fixture)
  })

  it.each([
    ['manifest', BundleManifestSchema, manifest],
    ['provenance', BundleProvenanceSchema, provenance],
    ['relations', BundleRelationsSchema, relations],
    ['artifacts index', ArtifactsIndexSchema, artifactsIndex],
  ] as const)('strictly rejects an extra key on %s', (_name, schema, fixture) => {
    expect(schema.safeParse({ ...fixture, smuggled: true }).success).toBe(false)
  })

  it.each([
    ['BundleManifest', guardBundleManifest, manifest],
    ['BundleProvenance', guardBundleProvenance, provenance],
    ['BundleRelations', guardBundleRelations, relations],
    ['ArtifactsIndex', guardArtifactsIndex, artifactsIndex],
  ] as const)('rejects a future %s version with a document-naming error', (name, guard, fixture) => {
    expect(() => guard({
      ...fixture,
      schemaVersion: BUNDLE_SCHEMA_VERSION + 1,
    })).toThrowError(VersionGuardError)
    expect(() => guard({
      ...fixture,
      schemaVersion: BUNDLE_SCHEMA_VERSION + 1,
    })).toThrow(name)
  })

  it('enforces the fact subtype law inside the manifest identity core', () => {
    expect(BundleManifestSchema.safeParse({
      ...manifest,
      identityCore: { ...manifest.identityCore, subtype: null },
    }).success).toBe(false)
    expect(BundleManifestSchema.safeParse({
      ...manifest,
      identityCore: {
        ...manifest.identityCore,
        kind: 'procedure',
        subtype: 'selector',
      },
    }).success).toBe(false)
  })
})

describe('computeMutableStateHash', () => {
  const input: MutableStateHashInput = {
    outcomes: DIGEST_A,
    relations: DIGEST_B,
    artifactsIndex: DIGEST_C,
  }

  it.each(['outcomes', 'relations', 'artifactsIndex', 'measurements'] as const)(
    'changes when the %s digest changes',
    (field) => {
      expect(computeMutableStateHash({ ...input, [field]: DIGEST_D }))
        .not.toBe(computeMutableStateHash(input))
    },
  )

  it('is insensitive to object insertion order', () => {
    const reordered: MutableStateHashInput = {
      artifactsIndex: DIGEST_C,
      relations: DIGEST_B,
      outcomes: DIGEST_A,
    }

    expect(computeMutableStateHash(reordered)).toBe(computeMutableStateHash(input))
  })

  it('excludes identity fields from the hash input by construction', () => {
    expectTypeOf<Parameters<typeof computeMutableStateHash>[0]>().toEqualTypeOf<{
      outcomes: string | null
      relations: string | null
      artifactsIndex: string | null
      measurements?: string | null
      gates?: string | null
    }>()
  })
})
