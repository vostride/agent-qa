// Deterministic committed-part rendering for one immutable bundle publication.
// Every returned text part is checkpointed as one unit by bundle-publish; manifest.json is
// deliberately rendered last and hashes every preceding committed part without hashing itself.

import { createHash } from 'node:crypto'

import {
  BUNDLE_SCHEMA_VERSION,
  canonicalJson,
  committedFileText,
  computeBundleIdentityHash,
  computeMutableStateHash,
  deriveDiscriminantKey,
  emitRecordMarkdown,
  mintBundleId,
  normalizeAnchor,
  renderEmbeddingInput,
  screenStateSnapshotRelPath,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactsIndex,
  BundleDiscriminant,
  BundleDraft,
  BundleIdentityCore,
  BundleIdentityInput,
  BundleManifest,
  BundleOutcomeEvent,
  BundleProvenance,
  BundleRelation,
  BundleRelations,
  CurationAuthorship,
  DistilledObservation,
  OriginClass,
  RecordFrontmatter,
  RecordId,
  ScreenState,
} from '@vostride/agent-qa-schema'

import type { ArtifactCopyResult } from './artifact-copy.js'

export interface RenderedBundlePart {
  relPath: string
  label: string
  text: string
}

export type BundleProvenanceInput =
  | {
      mode: 'run-linked'
      runId: string
      testId: string
      stepIndex: number
      curationJobId?: string
      sourceBuildOrdinal?: number
      authorship?: CurationAuthorship
      needsEnrichment?: boolean
      withheld?: boolean
    }
  | {
      mode: 'standalone'
      sourceDescription: string
    }

export interface RenderBundlePartsInput {
  draft: BundleDraft
  discriminant: BundleDiscriminant
  originClass: OriginClass
  createdAtOrdinal: number
  screenStates: readonly ScreenState[]
  initialEvents: readonly BundleOutcomeEvent[]
  relations: readonly BundleRelation[]
  provenance: BundleProvenanceInput
  copiedArtifacts: ArtifactCopyResult
  evidenceIncomplete: boolean
  evidenceMarkdown?: string
  distilledObservations?: readonly DistilledObservation[]
}

function textSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function part(relPath: string, text: string): RenderedBundlePart {
  return { relPath, label: relPath, text }
}

function validateIdentityInputs(
  draft: BundleDraft,
  discriminant: BundleDiscriminant,
): NonNullable<BundleDraft['subtype']> | null {
  if (draft.anchors.length === 0) {
    throw new TypeError('bundle draft requires at least one anchor')
  }
  if (discriminant.kind !== draft.kind) {
    throw new TypeError('bundle discriminant kind must match the draft kind')
  }
  if (draft.kind === 'fact') {
    if (draft.subtype === undefined) {
      throw new TypeError('fact bundle draft requires a subtype')
    }
    if (discriminant.kind !== 'fact' || discriminant.subtype !== draft.subtype) {
      throw new TypeError('fact bundle discriminant subtype must match the draft subtype')
    }
    return draft.subtype
  }
  if (draft.subtype !== undefined) {
    throw new TypeError('only fact bundle drafts may carry a subtype')
  }
  return null
}

function renderProvenance(
  provenance: BundleProvenanceInput,
  originClass: OriginClass,
): BundleProvenance {
  return provenance.mode === 'run-linked'
    ? {
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        mode: provenance.mode,
        originClass,
        runId: provenance.runId,
        testId: provenance.testId,
        stepIndex: provenance.stepIndex,
        ...(provenance.curationJobId === undefined
          ? {}
          : { curationJobId: provenance.curationJobId }),
        ...(provenance.sourceBuildOrdinal === undefined
          ? {}
          : { sourceBuildOrdinal: provenance.sourceBuildOrdinal }),
        ...(provenance.authorship === undefined
          ? {}
          : { authorship: provenance.authorship }),
        ...(provenance.needsEnrichment === undefined
          ? {}
          : { needsEnrichment: provenance.needsEnrichment }),
        ...(provenance.withheld === undefined
          ? {}
          : { withheld: provenance.withheld }),
      }
    : {
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        mode: provenance.mode,
        originClass,
        sourceDescription: provenance.sourceDescription,
      }
}

export function renderArtifactIndex(
  copiedArtifacts: ArtifactCopyResult,
): ArtifactsIndex {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    artifacts: copiedArtifacts.copied.map((copied) => ({
      id: copied.ref.id,
      sha: copied.ref.sha,
      bytes: copied.bytes,
      stepIndex: copied.stepIndex,
      relPath: copied.relPath,
      ...(copied.role === undefined ? {} : { role: copied.role }),
      ...(copied.originalName === undefined ? {} : { originalName: copied.originalName }),
      ...(copied.ref.evidenceIncomplete === undefined
        ? {}
        : { evidenceIncomplete: copied.ref.evidenceIncomplete }),
    })),
    ...(copiedArtifacts.skipped.length === 0
      ? {}
      : {
          skipped: copiedArtifacts.skipped.map((skipped) => ({
            id: skipped.ref.id,
            sha: skipped.ref.sha,
            stepIndex: skipped.stepIndex,
            path: `artifacts/${skipped.ref.sha}`,
            reason: skipped.reason,
          })),
        }),
  }
}

export function renderBundleParts(input: RenderBundlePartsInput): {
  parts: RenderedBundlePart[]
  id: RecordId
  identityHash: string
  identityCore: BundleIdentityCore
} {
  const subtype = validateIdentityInputs(input.draft, input.discriminant)
  const primaryAnchor = input.draft.anchors[0]!
  const discriminantKey = deriveDiscriminantKey(input.discriminant)
  const identityInput: BundleIdentityInput = {
    kind: input.draft.kind,
    ...(subtype === null ? {} : { subtype }),
    primaryAnchor,
    scope: input.draft.scope,
    discriminantKey,
  }
  const identityCore: BundleIdentityCore = {
    kind: input.draft.kind,
    subtype,
    primaryAnchor: normalizeAnchor(primaryAnchor),
    scope: input.draft.scope,
    discriminantKey,
  }
  const identityHash = computeBundleIdentityHash(identityInput)
  const id = mintBundleId(identityInput)
  const evidenceIncomplete =
    input.evidenceIncomplete || input.copiedArtifacts.evidenceIncomplete
  const anchors = input.draft.anchors.map((raw) => ({
    raw,
    normalized: normalizeAnchor(raw),
  }))
  const recordFrontmatter: RecordFrontmatter = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    id,
    kind: input.draft.kind,
    ...(subtype === null ? {} : { subtype }),
    anchors,
    scope: input.draft.scope,
    createdAtOrdinal: input.createdAtOrdinal,
    originClass: input.originClass,
    evidenceIncomplete,
  }
  const relations: BundleRelations = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    relations: [...input.relations],
  }
  const artifactsIndex = renderArtifactIndex(input.copiedArtifacts)
  const outcomesText = input.initialEvents
    .map((event) => `${canonicalJson(event)}\n`)
    .join('')
  const relationsText = committedFileText(relations)
  const artifactsIndexText = committedFileText(artifactsIndex)

  const parts: RenderedBundlePart[] = [
    part(
      'record.md',
      emitRecordMarkdown(recordFrontmatter, {
        summary: input.draft.summary,
        body: input.draft.body,
      }),
    ),
    part(
      'provenance.json',
      committedFileText(renderProvenance(input.provenance, input.originClass)),
    ),
    part('relations.json', relationsText),
    ...input.screenStates.map((screenState, stepIndex) =>
      part(screenStateSnapshotRelPath(stepIndex), committedFileText(screenState)),
    ),
    ...(input.distilledObservations === undefined
      ? []
      : [
          part(
            'observations.jsonl',
            input.distilledObservations
              .map((observation) => `${canonicalJson(observation)}\n`)
              .join(''),
          ),
        ]),
    part('evidence/outcomes.jsonl', outcomesText),
    ...(input.evidenceMarkdown === undefined
      ? []
      : [part('evidence/evidence.md', input.evidenceMarkdown)]),
    part('artifacts.index.json', artifactsIndexText),
  ]

  const manifest: BundleManifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    id,
    identityHash,
    identityCore,
    embeddingInput: renderEmbeddingInput({
      summary: input.draft.summary,
      body: input.draft.body,
      anchors: input.draft.anchors,
    }),
    contentHashes: Object.fromEntries(
      parts.map(({ relPath, text }) => [relPath, textSha(text)]),
    ),
    mutableStateHash: computeMutableStateHash({
      outcomes: textSha(outcomesText),
      relations: textSha(relationsText),
      artifactsIndex: textSha(artifactsIndexText),
    }),
    evidenceIncomplete,
    complete: true,
    createdAtOrdinal: input.createdAtOrdinal,
    originClass: input.originClass,
  }

  parts.push(part('manifest.json', committedFileText(manifest)))
  return { parts, id, identityHash, identityCore }
}
