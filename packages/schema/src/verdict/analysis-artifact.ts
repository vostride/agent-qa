// The run-directory analysis artifact.
//
// `analysis.json` is the analysis job's own receipt and the durable truth home for a run's
// authored verdicts and sentence parts — the document M5's run page, 392's chat and eval will
// consume. It is a NEW file beside `handoff.json` and `events.jsonl`, never a mutation of
// either (386 D-16's two-receipt law): the handoff records what the run observed, this file
// records what the analysis authored, and each job writes only its own receipt.
//
// The guard is pure — no fs in schema. The host adapter that puts these bytes on disk lives
// in `agent-local` (`writeAnalysisArtifact`), behind the `persistAnalysis` capability.

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

/**
 * What one analysis run durably authored.
 *
 * `verdicts` is the complete authored array — floor members and upgraded members alike —
 * and `parts` carries one sentence-parts record per verdict, joined by `perTest`.
 * The `verdicts-authored` checkpoint value stays byte-shape `{runId, verdicts}` exactly as
 * 388 froze it; parts live HERE and nowhere else.
 */
export interface RunAnalysisArtifact {
  schemaVersion: number
  runId: string
  verdicts: Verdict[]
  parts: VerdictSentenceParts[]
}

/**
 * Thrown when a stored artifact declares a `schemaVersion` this build cannot consume:
 * newer than {@link CURRENT_ANALYSIS_SCHEMA_VERSION}, or older with no registered
 * migration (the D-19 / §A8 version discipline the handoff guard set).
 */
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

/**
 * The artifact's fail-closed shape: root fields, every verdict structurally complete, and
 * every parts record parsed through the ONE zod contract — which is what routes each
 * `links` member through `EntityUriSchema` rather than a bare string check.
 *
 * `perTest` is the phase's one join key, and its uniqueness over BOTH arrays is a
 * one-document structural property enforced HERE for every stored/foreign artifact — this
 * guard is the one gate those bytes cross. The author path needs no
 * second gate: `evaluateAttempt` is first-entry-wins per testIndex (measured in plan 04),
 * so the shipped author cannot produce duplicates; the threat is foreign/stored bytes only.
 */
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

/**
 * The read half of the two-sided run-identity contract (G-389-3A, the 388 class).
 *
 * The write half derives the artifact's path FROM `artifact.runId` (the `persistAnalysis`
 * binding), so on an intact directory the recorded id and the resolved run agree by
 * construction. A copied, restored or foreign-written run directory breaks that agreement,
 * and this is the ONE place the comparison is spelled: both byte boundaries (the
 * agent-local artifact reader serving `analysis.get`/`runs.get`, and the canary fold's
 * loader) call it immediately after {@link guardRunAnalysisArtifact}.
 *
 * Consumers fold `run-mismatch` to `undefined` — the run's own deterministic floor. Never
 * adoption (the refusal exists so another run's verdicts and parts stay invisible whole),
 * and never a hard failure (the run's deterministic answer is intact; a mismatch is not
 * the version guard's corruption posture).
 */
export function admitAnalysisArtifactForRun(
  artifact: RunAnalysisArtifact,
  resolvingRunId: string,
): AnalysisArtifactAdmission {
  if (artifact.runId === resolvingRunId) return { kind: 'admitted', artifact }
  return { kind: 'run-mismatch', recordedRunId: artifact.runId, resolvingRunId }
}
