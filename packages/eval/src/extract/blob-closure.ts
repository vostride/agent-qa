import type { CassetteCompleteness, MissingCassetteEvidence } from '../cassette/completeness'
import type { CassetteInputLeg } from '../cassette/input-leg'
import type { ArtifactSource } from '../ports'

/** One content-addressed byte payload resolved in memory for a cassette bundle. */
export interface ExtractedBlob {
  sha: string
  bytes: Uint8Array
}

export interface ResolvedBlobClosure {
  blobs: ExtractedBlob[]
  missingShas: string[]
}

export interface BuildCompletenessInput {
  missingShas: readonly string[]
  anchorUnresolved: boolean
  unresolvedAnchorRef?: string
  missingEvidence?: readonly MissingCassetteEvidence[]
}

/**
 * Classify required screenshot identity from Plan 12's authoritative persisted modality.
 * Only `stateBefore.metadata.captureMode === 'full'` proves image evidence was attached;
 * a usable dedicated ref satisfies identity even when its bytes are later unavailable.
 */
export function missingRequiredEvidence(input: CassetteInputLeg): MissingCassetteEvidence[] {
  if (input.stateBefore.metadata.captureMode !== 'full') return []

  const ref = input.decisionScreenshotRef
  if (ref !== undefined && ref.evidenceIncomplete !== true) return []

  return [
    {
      kind: 'decision-screenshot-ref',
      stepIndex: input.stepIndex,
      decisionOrdinal: input.decisionOrdinal,
    },
  ]
}

/** Collect the ordered, deduplicated closure demanded by the projected typed input. */
export function collectBlobShas(input: CassetteInputLeg): string[] {
  const shas: string[] = []
  const seen = new Set<string>()
  const append = (sha: string): void => {
    if (seen.has(sha)) return
    seen.add(sha)
    shas.push(sha)
  }

  if (input.decisionScreenshotRef !== undefined) {
    append(input.decisionScreenshotRef.sha)
  }
  for (const artifact of input.auxiliaryArtifactRefs ?? []) append(artifact.sha)

  return shas
}

/** Resolve every demanded digest while preserving served bytes when siblings are absent. */
export function resolveBlobClosure(
  shas: readonly string[],
  artifacts: ArtifactSource,
): ResolvedBlobClosure {
  const blobs: ExtractedBlob[] = []
  const missingShas: string[] = []

  for (const sha of shas) {
    const bytes = artifacts.getBlob(sha)
    if (bytes === undefined) missingShas.push(sha)
    else blobs.push({ sha, bytes })
  }

  return { blobs, missingShas }
}

/** Fold independent missing-evidence facts into the single D-11 status vocabulary. */
export function buildCompleteness(input: BuildCompletenessInput): CassetteCompleteness {
  const hasMissingBlobs = input.missingShas.length > 0
  const hasMissingEvidence = (input.missingEvidence?.length ?? 0) > 0
  const status = hasMissingBlobs || hasMissingEvidence
    ? 'evidence-incomplete'
    : input.anchorUnresolved
      ? 'anchor-unresolved'
      : 'complete'

  return {
    status,
    ...(hasMissingBlobs ? { missingBlobShas: [...input.missingShas] } : {}),
    ...(input.anchorUnresolved && input.unresolvedAnchorRef !== undefined
      ? { unresolvedAnchorRef: input.unresolvedAnchorRef }
      : {}),
    ...(hasMissingEvidence ? { missingEvidence: [...input.missingEvidence!] } : {}),
  }
}
