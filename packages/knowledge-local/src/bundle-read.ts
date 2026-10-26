// The D-03 read face is the self-sufficiency oracle for committed bundles and Phase 375's
// projection source. It strictly parses disk-owned contracts, verifies every committed digest,
// and composes the schema fold; the LLM never supplies trust, counters, status, or validity.
// Manifest identity and immutable semantics are re-derived across files rather than trusted.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  GateLineSchema,
  receiptDigestOf,
  VersionGuardError,
  canonicalJson,
  computeMutableStateHash,
  foldBundleTrust,
  guardArtifactsIndex,
  guardBundleManifest,
  guardBundleProvenance,
  guardBundleRelations,
  measurementBaselineSchema,
  measurementObservationSchema,
  parseRecordMarkdown,
  renderEmbeddingInput,
  verifyManifestIdentity,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactsIndex,
  GateLine,
  BundleManifest,
  BundleOutcomeEvent,
  BundleProvenance,
  BundleRelations,
  DerivedTrustState,
  MeasurementBaseline,
  MeasurementObservation,
  RecordFrontmatter,
  ScreenState,
} from '@vostride/agent-qa-schema'

export interface LoadedBundle {
  frontmatter: RecordFrontmatter
  summary: string
  body: string
  manifest: BundleManifest
  provenance: BundleProvenance
  relations: BundleRelations
  events: BundleOutcomeEvent[]
  artifactsIndex: ArtifactsIndex
  screenStates: ScreenState[]
}

export type LoadBundleOutcome =
  | { kind: 'loaded'; bundle: LoadedBundle }
  | { kind: 'not-found' }
  | { kind: 'incomplete' }
  | { kind: 'version-error'; reason: string }
  | { kind: 'invalid'; reason: string }

export interface IntegrityReport {
  ok: boolean
  violations: string[]
}

const OUTCOMES_REL_PATH = 'evidence/outcomes.jsonl'
export const GATES_REL_PATH = 'evidence/gates.jsonl'
const MEASUREMENTS_REL_PATH = 'evidence/measurements.json'
const RELATIONS_REL_PATH = 'relations.json'
const ARTIFACTS_INDEX_REL_PATH = 'artifacts.index.json'
const SNAPSHOT_REL_PATH = /^evidence\/screenstates\/step-(\d+)\.json$/

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function snapshotPaths(manifest: BundleManifest): string[] {
  return Object.keys(manifest.contentHashes)
    .flatMap((relPath) => {
      const match = SNAPSHOT_REL_PATH.exec(relPath)
      return match === null ? [] : [{ relPath, stepIndex: Number(match[1]) }]
    })
    .sort((left, right) => left.stepIndex - right.stepIndex)
    .map(({ relPath }) => relPath)
}

function parseOutcomeLog(
  text: string,
  setCurrentFile: (file: string) => void,
): BundleOutcomeEvent[] {
  if (text === '') return []
  if (!text.endsWith('\n')) {
    throw new SyntaxError(`${OUTCOMES_REL_PATH} must end with a newline`)
  }

  return text
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      setCurrentFile(`${OUTCOMES_REL_PATH} line ${index + 1}`)
      return BundleOutcomeEventSchema.parse(JSON.parse(line))
    })
}

export interface Measurements {
  baseline: MeasurementBaseline
  observations: MeasurementObservation[]
}

/**
 * Read D-03's baseline-first append stream. Absence is normal for non-measurement
 * bundles; any present malformed line fails loudly through the strict schemas.
 */
export function readMeasurements(bundleDir: string): Measurements | undefined {
  const file = join(bundleDir, MEASUREMENTS_REL_PATH)
  if (!existsSync(file)) return undefined

  const text = readFileSync(file, 'utf8')
  if (text === '' || !text.endsWith('\n')) {
    throw new SyntaxError(`${MEASUREMENTS_REL_PATH} must contain a baseline and end with a newline`)
  }
  const lines = text.slice(0, -1).split('\n')
  return {
    baseline: measurementBaselineSchema.parse(JSON.parse(lines[0]!)),
    observations: lines.slice(1).map((line) =>
      measurementObservationSchema.parse(JSON.parse(line)),
    ),
  }
}

/** 416 D-03/D-04: absence is normal; a present receipt must attest this bundle and its bytes. */
export function readGateReceipts(bundleDir: string, bundleId: string): GateLine[] | undefined {
  const file = join(bundleDir, GATES_REL_PATH)
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  if (text === '' || !text.endsWith('\n')) {
    throw new SyntaxError(`${GATES_REL_PATH} must contain a receipt and end with a newline`)
  }
  return text.slice(0, -1).split('\n').map((line, index) => {
    // Parser diagnostics can quote receipt bytes or unrecognized keys. Only
    // fixed categories and the line number may cross the shared read boundary;
    // deliberately retain no raw parser error as a serialized cause.
    const label = `${GATES_REL_PATH} line ${index + 1}`
    let value: unknown
    try { value = JSON.parse(line) } catch {
      throw new SyntaxError(`${label}: invalid JSON`)
    }
    const result = GateLineSchema.safeParse(value)
    if (!result.success) throw new SyntaxError(`${label}: invalid receipt schema`)
    const parsed = result.data
    if (parsed.candidateId !== bundleId) {
      throw new SyntaxError(`${GATES_REL_PATH} line ${index + 1}: foreign candidateId`)
    }
    if (receiptDigestOf(parsed) !== parsed.receiptDigest) {
      throw new SyntaxError(`${GATES_REL_PATH} line ${index + 1}: receiptDigest mismatch`)
    }
    if (canonicalJson(parsed) !== line) {
      throw new SyntaxError(`${GATES_REL_PATH} line ${index + 1}: expected canonical JSON`)
    }
    return parsed
  })
}

export function loadBundle(bundleDir: string): LoadBundleOutcome {
  if (basename(bundleDir).startsWith('.')) return { kind: 'not-found' }
  try {
    if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
      return { kind: 'not-found' }
    }
  } catch {
    return { kind: 'not-found' }
  }

  const manifestPath = join(bundleDir, 'manifest.json')
  if (!existsSync(manifestPath)) return { kind: 'not-found' }

  let currentFile = 'manifest.json'
  try {
    const manifest = guardBundleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    if (manifest.complete !== true) return { kind: 'incomplete' }

    currentFile = GATES_REL_PATH
    readGateReceipts(bundleDir, manifest.id)

    currentFile = 'record.md'
    const record = parseRecordMarkdown(readFileSync(join(bundleDir, currentFile), 'utf8'))

    currentFile = 'provenance.json'
    const provenance = guardBundleProvenance(
      JSON.parse(readFileSync(join(bundleDir, currentFile), 'utf8')),
    )

    currentFile = RELATIONS_REL_PATH
    const relations = guardBundleRelations(
      JSON.parse(readFileSync(join(bundleDir, currentFile), 'utf8')),
    )

    currentFile = ARTIFACTS_INDEX_REL_PATH
    const artifactsIndex = guardArtifactsIndex(
      JSON.parse(readFileSync(join(bundleDir, currentFile), 'utf8')),
    )

    currentFile = OUTCOMES_REL_PATH
    const events = parseOutcomeLog(
      readFileSync(join(bundleDir, currentFile), 'utf8'),
      (file) => {
        currentFile = file
      },
    )

    const screenStates = snapshotPaths(manifest).map((relPath) => {
      currentFile = relPath
      return JSON.parse(readFileSync(join(bundleDir, relPath), 'utf8')) as ScreenState
    })

    return {
      kind: 'loaded',
      bundle: {
        frontmatter: record.frontmatter,
        summary: record.summary,
        body: record.body,
        manifest,
        provenance,
        relations,
        events,
        artifactsIndex,
        screenStates,
      },
    }
  } catch (error) {
    const reason = `${currentFile}: ${errorMessage(error)}`
    return error instanceof VersionGuardError
      ? { kind: 'version-error', reason }
      : { kind: 'invalid', reason }
  }
}

function byteSha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readDigest(bundleDir: string, relPath: string, violations: string[]): string | null {
  try {
    return byteSha(readFileSync(join(bundleDir, relPath)))
  } catch (error) {
    violations.push(`${relPath}: missing or unreadable (${errorMessage(error)})`)
    return null
  }
}

function verifyManifestBindings(
  bundleDir: string,
  manifest: BundleManifest,
  violations: string[],
): void {
  try {
    const record = parseRecordMarkdown(readFileSync(join(bundleDir, 'record.md'), 'utf8'))
    const { frontmatter } = record

    if (frontmatter.id !== manifest.id) {
      violations.push('record.md: id mismatch with manifest.json')
    }
    if (frontmatter.kind !== manifest.identityCore.kind) {
      violations.push('record.md: kind mismatch with manifest.identityCore')
    }
    if ((frontmatter.subtype ?? null) !== manifest.identityCore.subtype) {
      violations.push('record.md: subtype mismatch with manifest.identityCore')
    }
    if (canonicalJson(frontmatter.scope) !== canonicalJson(manifest.identityCore.scope)) {
      violations.push('record.md: scope mismatch with manifest.identityCore')
    }

    const primaryAnchor = frontmatter.anchors[0]?.normalized
    if (
      primaryAnchor === undefined ||
      canonicalJson(primaryAnchor) !== canonicalJson(manifest.identityCore.primaryAnchor)
    ) {
      violations.push('record.md: primary anchor mismatch with manifest.identityCore')
    }
    if (frontmatter.createdAtOrdinal !== manifest.createdAtOrdinal) {
      violations.push('record.md: createdAtOrdinal mismatch with manifest.json')
    }
    if (frontmatter.originClass !== manifest.originClass) {
      violations.push('record.md: originClass mismatch with manifest.json')
    }
    if (frontmatter.evidenceIncomplete !== manifest.evidenceIncomplete) {
      violations.push('record.md: evidenceIncomplete mismatch with manifest.json')
    }

    const embeddingInput = renderEmbeddingInput({
      summary: record.summary,
      body: record.body,
      anchors: frontmatter.anchors.map(({ raw }) => raw),
    })
    if (embeddingInput !== manifest.embeddingInput) {
      violations.push('record.md: embeddingInput mismatch with manifest.json')
    }
  } catch (error) {
    violations.push(`record.md: immutable cross-checks unavailable (${errorMessage(error)})`)
  }

  try {
    const provenance = guardBundleProvenance(
      JSON.parse(readFileSync(join(bundleDir, 'provenance.json'), 'utf8')),
    )
    if (provenance.originClass !== manifest.originClass) {
      violations.push('provenance.json: originClass mismatch with manifest.json')
    }
  } catch (error) {
    violations.push(
      `provenance.json: immutable cross-checks unavailable (${errorMessage(error)})`,
    )
  }
}

export function verifyBundleIntegrity(bundleDir: string): IntegrityReport {
  const violations: string[] = []
  let manifest: BundleManifest

  try {
    manifest = guardBundleManifest(
      JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')),
    )
  } catch (error) {
    return {
      ok: false,
      violations: [`manifest.json: invalid or unreadable (${errorMessage(error)})`],
    }
  }

  for (const violation of verifyManifestIdentity(manifest)) {
    violations.push(`manifest.json: ${violation}`)
  }
  verifyManifestBindings(bundleDir, manifest, violations)

  if (manifest.complete !== true) {
    violations.push('manifest.json: bundle is incomplete')
  }

  const actualDigests: Record<string, string> = {}
  for (const [relPath, expectedDigest] of Object.entries(manifest.contentHashes).sort()) {
    const actualDigest = readDigest(bundleDir, relPath, violations)
    if (actualDigest === null) continue
    actualDigests[relPath] = actualDigest
    if (actualDigest !== expectedDigest) {
      violations.push(`${relPath}: content hash mismatch`)
    }
  }

  const measurements = actualDigests[MEASUREMENTS_REL_PATH]
  const gates = actualDigests[GATES_REL_PATH]
  const mutableStateHash = computeMutableStateHash({
    outcomes: actualDigests[OUTCOMES_REL_PATH] ?? null,
    relations: actualDigests[RELATIONS_REL_PATH] ?? null,
    artifactsIndex: actualDigests[ARTIFACTS_INDEX_REL_PATH] ?? null,
    ...(measurements === undefined ? {} : { measurements }),
    ...(gates === undefined ? {} : { gates }),
  })
  if (mutableStateHash !== manifest.mutableStateHash) {
    violations.push('manifest.json: mutableStateHash mismatch')
  }

  try {
    const artifactsIndex = guardArtifactsIndex(
      JSON.parse(readFileSync(join(bundleDir, ARTIFACTS_INDEX_REL_PATH), 'utf8')),
    )
    for (const artifact of artifactsIndex.artifacts) {
      const artifactPath = join(bundleDir, artifact.relPath)
      if (!existsSync(artifactPath)) {
        violations.push(`${artifact.relPath}: dangling artifact reference`)
        continue
      }
      let bytes: Buffer
      try {
        bytes = readFileSync(artifactPath)
      } catch (error) {
        violations.push(`${artifact.relPath}: unreadable artifact (${errorMessage(error)})`)
        continue
      }
      if (byteSha(bytes) !== artifact.sha) {
        violations.push(`${artifact.relPath}: artifact byte hash mismatch`)
      }
      if (bytes.byteLength !== artifact.bytes) {
        violations.push(`${artifact.relPath}: artifact byte length mismatch`)
      }
    }
  } catch (error) {
    violations.push(`${ARTIFACTS_INDEX_REL_PATH}: invalid or unreadable (${errorMessage(error)})`)
  }

  return { ok: violations.length === 0, violations }
}

/**
 * Phase 375 consumes this exact disk-derived projection seam; no model-produced scalar enters it.
 */
export function deriveBundleTrust(loaded: LoadedBundle): DerivedTrustState {
  return foldBundleTrust(loaded.events, {
    originClass: loaded.provenance.originClass,
    evidenceIncomplete: loaded.manifest.evidenceIncomplete,
    createdAtOrdinal: loaded.manifest.createdAtOrdinal,
  })
}
