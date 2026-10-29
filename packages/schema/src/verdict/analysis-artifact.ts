// A new file beside `handoff.json`, never a mutation: each job writes only its own receipt.

import {
  createVersionGuard,
  VersionGuardError,
} from '../versioning/create-version-guard'
import type { MigrationRegistry } from '../versioning/create-version-guard'
import { hasMemoryOnPathShape } from './memory-on-path'
import { VerdictSentencePartsSchema } from './sentence-parts'
import type { VerdictSentenceParts } from './sentence-parts'
import { isVerdictClass } from './verdict'
import type { Verdict } from './verdict'

export const CURRENT_ANALYSIS_SCHEMA_VERSION = 2

/** The artifact's file name inside a run directory: `runs/<slug(runId)>/analysis.json`. */
export const ANALYSIS_FILE = 'analysis.json'

// Parts live here only; the `verdicts-authored` checkpoint keeps its `{runId, verdicts}` shape.
export interface RunAnalysisArtifact {
  schemaVersion: number
  runId: string
  verdicts: Verdict[]
  parts: VerdictSentenceParts[]
}

// Newer than the current version, or older with no registered migration.
export class AnalysisVersionError extends VersionGuardError {
  constructor(found: number, supported: number) {
    super('RunAnalysisArtifact', found, supported)
    this.name = 'AnalysisVersionError'
  }
}

export const ANALYSIS_MIGRATIONS: MigrationRegistry = {}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Structural check on one stored verdict, at the depth the artifact's consumers traverse:
 * class inside the closed union, a declared producer, and consumer-traversable evidence
 * arrays — the same discipline the handoff guard applies to a present `rootCause`.
 */
function hasVerdictShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  if (!isVerdictClass(value.class)) return false
  if (
    value.producer !== 'deterministic-classifier' &&
    value.producer !== 'analyze-run'
  ) {
    return false
  }
  if (typeof value.confidence !== 'number') return false
  const evidence = value.evidence
  if (!isNonArrayObject(evidence)) return false
  if (!Array.isArray(evidence.citedSteps)) return false
  if (!Array.isArray(evidence.citedAnchors)) return false
  if (!Array.isArray(evidence.citedArtifacts)) return false
  if (typeof evidence.rationale !== 'string') return false
  if (typeof value.memoryMisdirectionRuledOut !== 'boolean') return false
  if (typeof value.perTest !== 'number') return false
  // A malformed present `memoryOnPath` is refused, not dropped: a stripped claim reads like one
  // that was never made.
  if (!hasMemoryOnPathShape(value)) return false
  return true
}

// `perTest` must be unique in both arrays; this guard is the one gate stored bytes cross.
function hasCompleteArtifactShape(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false
  return (
    typeof value.schemaVersion === 'number' &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    Array.isArray(value.verdicts) &&
    value.verdicts.every(hasVerdictShape) &&
    new Set(value.verdicts.map((verdict) => (verdict as { perTest: number }).perTest))
      .size === value.verdicts.length &&
    Array.isArray(value.parts) &&
    value.parts.every((part) => VerdictSentencePartsSchema.safeParse(part).success) &&
    new Set(value.parts.map((part) => (part as { perTest: number }).perTest)).size ===
      value.parts.length
  )
}

/**
 * The read side of the artifact version discipline: parse → refuse any stamp other than the
 * current one with a typed {@link AnalysisVersionError} → structural check. Every future artifact
 * consumer routes through this one guard.
 */
export const guardRunAnalysisArtifact = createVersionGuard<RunAnalysisArtifact>({
  name: 'RunAnalysisArtifact',
  current: CURRENT_ANALYSIS_SCHEMA_VERSION,
  migrations: ANALYSIS_MIGRATIONS,
  error: AnalysisVersionError,
  shape: hasCompleteArtifactShape,
})

/**
 * The typed answer of {@link admitAnalysisArtifactForRun}: the artifact by identity when
 * its recorded `runId` is the run being resolved, or a `run-mismatch` refusal carrying
 * both ids — the shape a consumer folds to the deterministic floor, never adopts.
 */
export type AnalysisArtifactAdmission =
  | { kind: 'admitted'; artifact: RunAnalysisArtifact }
  | { kind: 'run-mismatch'; recordedRunId: string; resolvingRunId: string }

// Consumers fold `run-mismatch` to the deterministic floor: never adopted, never a hard failure.
export function admitAnalysisArtifactForRun(
  artifact: RunAnalysisArtifact,
  resolvingRunId: string,
): AnalysisArtifactAdmission {
  if (artifact.runId === resolvingRunId) return { kind: 'admitted', artifact }
  return { kind: 'run-mismatch', recordedRunId: artifact.runId, resolvingRunId }
}
