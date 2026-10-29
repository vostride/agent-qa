// Filesystem cassette bundle loader.
//
// Inverts FsCassetteStore's write leg: reads `cassette.json`, version-gates + structurally validates
// it through guardCassette (the V5 input-validation control), and binds a DirArtifactSource over the
// bundle's `blobs/` directory. A cassette bundle is an untrusted, hand-editable, cross-machine
// document, so every failure — an unreadable/missing file, unparseable JSON, or a guard rejection —
// becomes a typed ReplayRefusal instead of a throw. The cassette is never partially loaded and never
// replayed on refusal; the refusal surfaces in reports and the surrounding batch always survives.

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  guardCassette,
  type ArtifactSource,
  type Cassette,
  type ReplayRefusal,
} from '@vostride/agent-qa-eval'

import { DirArtifactSource } from './artifact-source.js'
import { BLOBS_SUBDIR, CASSETTE_FILE } from './cassette-store.js'

/** The discriminated bundle-load outcome: a guarded cassette + its blob source, or a typed refusal. */
export type CassetteBundleLoad =
  | { kind: 'loaded'; cassette: Cassette; artifacts: ArtifactSource }
  | { kind: 'refused'; refusal: ReplayRefusal }

function refused(
  cassetteId: string,
  reason: ReplayRefusal['reason'],
  detail: string,
): CassetteBundleLoad {
  return { kind: 'refused', refusal: { kind: 'integrity-refusal', cassetteId, reason, detail } }
}

// Recover the recorded id from a parsed-but-rejected document so the refusal is attributable; falls
// back to the bundle directory basename when the id is unrecoverable (unparseable / absent / non-string).
function recoverCassetteId(document: unknown, fallback: string): string {
  if (typeof document === 'object' && document !== null) {
    const id = (document as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return fallback
}

/**
 * Load a cassette bundle directory into a guarded Cassette + DirArtifactSource over its blobs.
 * Never throws for a malformed bundle — read/parse failures map to a 'parse-failed' refusal and
 * guard rejections (version or structural) map to 'guard-failed', each carrying the underlying
 * message in `detail`.
 */
export function loadCassetteBundle(bundleDir: string): CassetteBundleLoad {
  const fallbackId = basename(bundleDir)
  const cassettePath = join(bundleDir, CASSETTE_FILE)

  let raw: string
  try {
    raw = readFileSync(cassettePath, 'utf8')
  } catch (error) {
    return refused(
      fallbackId,
      'parse-failed',
      `Failed to read ${cassettePath}: ${(error as NodeJS.ErrnoException).message}`,
    )
  }

  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    return refused(
      fallbackId,
      'parse-failed',
      `Invalid cassette JSON at ${cassettePath}: ${(error as Error).message}`,
    )
  }

  let cassette: Cassette
  try {
    cassette = guardCassette(document)
  } catch (error) {
    return refused(recoverCassetteId(document, fallbackId), 'guard-failed', (error as Error).message)
  }

  const artifacts = new DirArtifactSource({ dir: join(bundleDir, BLOBS_SUBDIR) })
  return { kind: 'loaded', cassette, artifacts }
}
