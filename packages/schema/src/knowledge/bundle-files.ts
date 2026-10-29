import { z } from 'zod'

import type { CurationAuthorship, CurationAuthorshipPath } from '../delta/envelope'
import type { BundleIdentityCore } from '../ids/content-address'
import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import type { ExecutionContext } from '../run/run-status'
import { createVersionGuard } from '../versioning/create-version-guard'
import type { OriginClass } from './outcome-event'

// One version governs every committed JSON artifact in a bundle directory.
export const BUNDLE_SCHEMA_VERSION = 2

const bundleKindSchema = z.enum(['fact', 'procedure', 'caution', 'unknown', 'policy'])
const factSubtypeSchema = z.enum([
  'selector',
  'behavioral',
  'navigational',
  'measurement',
  'content',
])
const originClassSchema: z.ZodType<OriginClass> = z.enum([
  'user',
  'agent-verified',
  'agent-observed',
  'import',
])
const curationAuthorshipPaths = [
  'llm',
  'llm-repaired',
  'deterministic-fallback',
] as const satisfies readonly CurationAuthorshipPath[]
const executionContexts = [
  'local-interactive',
  'local-headless',
  'ci',
  'cloud',
] as const satisfies readonly ExecutionContext[]
const curationAuthorshipSchema: z.ZodType<CurationAuthorship> = z.object({
  path: z.enum(curationAuthorshipPaths),
  model: z.object({
    id: z.string(),
    family: z.string().optional(),
    fingerprint: z.string().optional(),
  }).strict().optional(),
  executionContext: z.enum(executionContexts),
  // A diagnostic only; trust and tier never read it.
  fallbackReason: z
    .enum(['malformed', 'no-model', 'token-budget', 'model-error'])
    .optional(),
}).strict()
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase SHA-256 hex digest')

const anchorSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('page'), route: z.string() }).strict(),
  z.object({ t: z.literal('flow'), name: z.string() }).strict(),
  z.object({
    t: z.literal('el'),
    role: z.string(),
    name: z.string(),
    ordinal: z.number().int().optional(),
  }).strict(),
  z.object({
    t: z.literal('platform'),
    platform: z.enum(['web', 'android', 'ios']),
  }).strict(),
  z.object({ t: z.literal('selector'), literal: z.string() }).strict(),
  z.object({ t: z.literal('error'), message: z.string() }).strict(),
])

const scopeKeySchema = z.object({
  tier: z.enum(['global', 'product', 'suite', 'test']),
  key: z.string(),
}).strict()

const bundleIdentityCoreSchema: z.ZodType<BundleIdentityCore> = z.object({
  kind: bundleKindSchema,
  subtype: factSubtypeSchema.nullable(),
  primaryAnchor: anchorSchema,
  scope: scopeKeySchema,
  discriminantKey: z.string(),
}).strict().superRefine((identity, ctx) => {
  if (identity.kind === 'fact' && identity.subtype === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['subtype'],
      message: 'fact bundle identity requires a fact subtype (D-06)',
    })
  }
  if (identity.kind !== 'fact' && identity.subtype !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['subtype'],
      message: 'only fact bundle identity may carry a subtype (D-06)',
    })
  }
})

const committedRelPathSchema = z.string().refine((value) => {
  if (value === '' || value.startsWith('/') || value.includes('\\')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}, 'expected a bundle-relative committed file path')

/** The manifest is both the immutable identity echo and the mutable rebuild contract. */
export const BundleManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string(),
  identityHash: sha256Schema,
  identityCore: bundleIdentityCoreSchema,
  embeddingInput: z.string(),
  contentHashes: z.record(committedRelPathSchema, sha256Schema),
  mutableStateHash: sha256Schema,
  evidenceIncomplete: z.boolean(),
  complete: z.boolean(),
  createdAtOrdinal: z.number(),
  originClass: originClassSchema,
}).strict().superRefine((manifest, ctx) => {
  if (Object.hasOwn(manifest.contentHashes, 'manifest.json')) {
    ctx.addIssue({
      code: 'custom',
      path: ['contentHashes', 'manifest.json'],
      message: 'manifest.json cannot hash itself',
    })
  }
})

export type BundleManifest = z.infer<typeof BundleManifestSchema>

/**
 * Graceful-degradation provenance: in-bundle evidence remains authoritative even when a
 * run-linked deep-audit reference is unavailable on the reading machine (§3.1).
 */
export const BundleProvenanceSchema = z.discriminatedUnion('mode', [
  z.object({
    schemaVersion: z.number().int().positive(),
    mode: z.literal('run-linked'),
    originClass: originClassSchema,
    runId: z.string(),
    testId: z.string(),
    stepIndex: z.number().int().nonnegative(),
    curationJobId: z.string().optional(),
    sourceBuildOrdinal: z.number().optional(),
    authorship: curationAuthorshipSchema.optional(),
    // Deterministic fallback output may request capable-model re-processing.
    needsEnrichment: z.boolean().optional(),
    // Injection-flagged candidates stay out of serving and promotion until a local re-review.
    withheld: z.boolean().optional(),
  }).strict(),
  z.object({
    schemaVersion: z.number().int().positive(),
    mode: z.literal('standalone'),
    originClass: originClassSchema,
    sourceDescription: z.string(),
  }).strict(),
])

export type BundleProvenance = z.infer<typeof BundleProvenanceSchema>

const bundleRelationSchema = z.object({
  type: z.enum([
    'supersedes',
    'superseded-by',
    'derived-from',
    'conflicts-with',
    'relates-to',
    'renamed-from',
    'equivalent-to',
    'proposed-supersession-of',
  ]),
  targetId: z.string(),
  addedAtOrdinal: z.number(),
  curationJobId: z.string(),
}).strict()

export const BundleRelationsSchema = z.object({
  schemaVersion: z.number().int().positive(),
  relations: z.array(bundleRelationSchema),
}).strict()

export type BundleRelation = z.infer<typeof bundleRelationSchema>
export type BundleRelations = z.infer<typeof BundleRelationsSchema>

const artifactIndexEntrySchema = z.object({
  id: z.string(),
  sha: sha256Schema,
  bytes: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  relPath: z.string().regex(/^artifacts\/[0-9a-f]{64}$/),
  role: z.string().optional(),
  originalName: z.string().optional(),
  evidenceIncomplete: z.boolean().optional(),
}).strict().superRefine((artifact, ctx) => {
  if (artifact.relPath !== `artifacts/${artifact.sha}`) {
    ctx.addIssue({
      code: 'custom',
      path: ['relPath'],
      message: 'artifact relPath must match its content SHA',
    })
  }
})

const skippedArtifactIndexEntrySchema = z.object({
  id: z.string(),
  sha: sha256Schema,
  stepIndex: z.number().int().nonnegative(),
  path: z.string(),
  reason: z.enum([
    'step-cap',
    'run-cap',
    'pruned-source',
    'sha-mismatch',
  ]),
}).strict()

export const ArtifactsIndexSchema = z.object({
  schemaVersion: z.number().int().positive(),
  artifacts: z.array(artifactIndexEntrySchema),
  /** Skipped artifacts: bytes are intentionally absent and the refusal reason is durable. */
  skipped: z.array(skippedArtifactIndexEntrySchema).optional(),
}).strict()

export type ArtifactsIndex = z.infer<typeof ArtifactsIndexSchema>

const guardBundleManifestVersion = createVersionGuard<BundleManifest>({
  name: 'BundleManifest',
  current: BUNDLE_SCHEMA_VERSION,
  migrations: {},
})
const guardBundleProvenanceVersion = createVersionGuard<BundleProvenance>({
  name: 'BundleProvenance',
  current: BUNDLE_SCHEMA_VERSION,
  migrations: {},
})
const guardBundleRelationsVersion = createVersionGuard<BundleRelations>({
  name: 'BundleRelations',
  current: BUNDLE_SCHEMA_VERSION,
  migrations: {},
})
const guardArtifactsIndexVersion = createVersionGuard<ArtifactsIndex>({
  name: 'ArtifactsIndex',
  current: BUNDLE_SCHEMA_VERSION,
  migrations: {},
})

export function guardBundleManifest(value: unknown): BundleManifest {
  return BundleManifestSchema.parse(guardBundleManifestVersion(value))
}

export function guardBundleProvenance(value: unknown): BundleProvenance {
  return BundleProvenanceSchema.parse(guardBundleProvenanceVersion(value))
}

export function guardBundleRelations(value: unknown): BundleRelations {
  return BundleRelationsSchema.parse(guardBundleRelationsVersion(value))
}

export function guardArtifactsIndex(value: unknown): ArtifactsIndex {
  return ArtifactsIndexSchema.parse(guardArtifactsIndexVersion(value))
}

export interface MutableStateHashInput {
  outcomes: string | null
  relations: string | null
  artifactsIndex: string | null
  // Optional so bundles without measurements.json keep their mutable-state hash.
  measurements?: string | null
  // Omitted until the gate part exists, so bundle hashes without it stay the same.
  gates?: string | null
}

// Only mutable-file content digests enter this hash; identity, embedding status and prose never do.
export function computeMutableStateHash(input: MutableStateHashInput): string {
  return sha256hex(canonicalJson(input))
}
