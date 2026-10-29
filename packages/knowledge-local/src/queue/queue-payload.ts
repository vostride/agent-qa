import { z } from 'zod'

import {
  canonicalJson,
  cautionRootCauseClassSchema,
  distilledObservationSchema,
  sha256hex,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  BundleKind,
  CautionRootCauseClass,
  ExecutionContext,
  FactSubtype,
  ScopeKey,
} from '@vostride/agent-qa-schema'

import { anchorSchema } from '../anchor-schema.js'

export const CURATION_QUEUE_SCHEMA_VERSION = 2

const SHA256_HEX = /^[0-9a-f]{64}$/

const scopeSchema: z.ZodType<ScopeKey> = z
  .object({
    tier: z.enum(['global', 'product', 'suite', 'test']),
    key: z.string().min(1),
  })
  .strict()

const bundleKindSchema: z.ZodType<BundleKind> = z.enum([
  'fact',
  'procedure',
  'caution',
  'unknown',
  'policy',
])
const factSubtypeSchema: z.ZodType<FactSubtype> = z.enum([
  'selector',
  'behavioral',
  'navigational',
  'measurement',
  'content',
])
const executionContextSchema: z.ZodType<ExecutionContext> = z.enum([
  'local-interactive',
  'local-headless',
  'ci',
  'cloud',
])

export const curationArtifactRoleSchema = z.enum([
  'screenshot',
  'dom-snapshot',
  'ax-snapshot',
  'opaque-evidence',
])

const artifactRefSchema: z.ZodType<ArtifactRef> = z
  .object({
    id: z.string().min(1),
    sha: z.string().regex(SHA256_HEX),
    evidenceIncomplete: z.boolean().optional(),
  })
  .strict()

export const curationArtifactDescriptorSchema = z
  .object({
    ref: artifactRefSchema,
    stepIndex: z.number().int().nonnegative(),
    role: curationArtifactRoleSchema,
    originalName: z.string().min(1),
  })
  .strict()

const artifactInventoryEntryShape = {
  relativePath: z.string().regex(/^artifacts\/[0-9a-f]{64}$/),
  sha256: z.string().regex(SHA256_HEX),
  bytes: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
} as const

function validateArtifactInventoryEntry(
  entry: { relativePath: string; sha256: string },
  ctx: z.RefinementCtx,
): void {
  if (entry.relativePath !== `artifacts/${entry.sha256}`) {
    ctx.addIssue({
      code: 'custom',
      path: ['relativePath'],
      message: 'artifact relativePath must match its SHA-256 digest',
    })
  }
}

const artifactInventoryEntrySchema = z
  .object({
    ...artifactInventoryEntryShape,
    role: curationArtifactRoleSchema,
    originalName: z.string().min(1),
  })
  .strict()
  .superRefine(validateArtifactInventoryEntry)

const candidateSeedShape = {
  sourceRunId: z.string().min(1),
  scope: scopeSchema,
  buildOrdinal: z.number().int().nonnegative(),
  executionContext: executionContextSchema,
  kind: bundleKindSchema,
  subtype: factSubtypeSchema.optional(),
  // Optional, so existing queue-v2 bytes stay valid; when present it joins the address.
  rootCauseClass: cautionRootCauseClassSchema.optional(),
  anchors: z.array(anchorSchema).min(1),
  summarySeed: z.string(),
  bodySeed: z.string(),
  distilledObservations: z.array(distilledObservationSchema),
  evidenceToken: z.string().min(1),
  attributingObservationId: z.string().min(1),
} as const

const addressShape = {
  schemaVersion: z.literal(CURATION_QUEUE_SCHEMA_VERSION),
  ...candidateSeedShape,
  artifactInventory: z.array(artifactInventoryEntrySchema),
  /** Diagnostic only; wall-clock metadata is excluded from queue identity. */
  emittedAt: z.string(),
} as const

export const curationCandidateProjectionSchema = z
  .object({
    ...candidateSeedShape,
    artifactDescriptors: z.array(curationArtifactDescriptorSchema),
    /** Diagnostic only; queue finalization excludes wall-clock metadata from identity. */
    emittedAt: z.string(),
  })
  .strict()
  .superRefine(validateProjectionSemantics)

function validateKindSemantics(
  value: {
    kind: BundleKind
    subtype?: FactSubtype
    rootCauseClass?: CautionRootCauseClass
  },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === 'fact' && value.subtype === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['subtype'],
      message: 'fact candidates require a fact subtype',
    })
  }
  if (value.kind !== 'fact' && value.subtype !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['subtype'],
      message: 'only fact candidates may carry a fact subtype',
    })
  }
  if (value.rootCauseClass !== undefined && value.kind !== 'caution') {
    ctx.addIssue({
      code: 'custom',
      path: ['rootCauseClass'],
      message: 'only caution candidates may carry a root-cause class',
    })
  }
}

function validateProjectionSemantics(
  value: {
    kind: BundleKind
    subtype?: FactSubtype
    rootCauseClass?: CautionRootCauseClass
    artifactDescriptors: readonly { ref: ArtifactRef }[]
  },
  ctx: z.RefinementCtx,
): void {
  validateKindSemantics(value, ctx)
  const refs = new Set<string>()
  for (const [index, descriptor] of value.artifactDescriptors.entries()) {
    if (refs.has(descriptor.ref.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifactDescriptors', index, 'ref', 'id'],
        message: 'artifact descriptor refs must be unique',
      })
    }
    refs.add(descriptor.ref.id)
  }
}

function validateAddressSemantics(
  value: {
    kind: BundleKind
    subtype?: FactSubtype
    rootCauseClass?: CautionRootCauseClass
    artifactInventory: readonly {
      relativePath: string
      sha256: string
      stepIndex: number
      role: z.infer<typeof curationArtifactRoleSchema>
      originalName: string
    }[]
  },
  ctx: z.RefinementCtx,
): void {
  validateKindSemantics(value, ctx)
  const paths = new Set<string>()
  for (const [index, artifact] of value.artifactInventory.entries()) {
    if (paths.has(artifact.relativePath)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifactInventory', index, 'relativePath'],
        message: 'artifact inventory paths must be unique',
      })
    }
    paths.add(artifact.relativePath)
  }
}

const curationCandidateAddressFieldsSchema = z
  .object(addressShape)
  .strict()
  .superRefine(validateAddressSemantics)

export const curationCandidatePayloadSchema = z
  .object({
    candidateId: z.string().regex(SHA256_HEX),
    ...addressShape,
  })
  .strict()
  .superRefine((payload, ctx) => {
    validateAddressSemantics(payload, ctx)
    const { candidateId, ...fields } = payload
    if (candidateId !== candidateContentAddress(fields)) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidateId'],
        message: 'candidateId must equal the deterministic payload content address',
      })
    }
  })

export type CurationCandidateAddressFields = z.infer<
  typeof curationCandidateAddressFieldsSchema
>
export type CurationCandidatePayload = z.infer<typeof curationCandidatePayloadSchema>
export type CurationCandidateArtifact = z.infer<typeof artifactInventoryEntrySchema>
export type CurationArtifactRole = z.infer<typeof curationArtifactRoleSchema>
export type CurationArtifactDescriptor = z.infer<
  typeof curationArtifactDescriptorSchema
>
export type CurationCandidateProjection = z.infer<
  typeof curationCandidateProjectionSchema
>
export type BuildCurationCandidateAddressFieldsInput = CurationCandidateAddressFields

/** Constructs strict version-2 fields with descriptor metadata for every copied artifact. */
export function buildCurationCandidateAddressFields(
  input: BuildCurationCandidateAddressFieldsInput,
): CurationCandidateAddressFields {
  return curationCandidateAddressFieldsSchema.parse(input)
}

/**
 * Hashes every payload field except derived candidateId and diagnostic emittedAt. Identity covers
 * schema/run/scope/ordinal/execution context, candidate kind/subtype, anchors and seeds, distilled
 * observations, evidence attribution, and the complete artifact inventory.
 */
export function candidateContentAddress(fields: CurationCandidateAddressFields): string {
  const parsed = curationCandidateAddressFieldsSchema.parse(fields)
  const { emittedAt: _diagnostic, ...deterministic } = parsed
  return sha256hex(canonicalJson(deterministic))
}
