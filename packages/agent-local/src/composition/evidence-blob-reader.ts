// Both consumers bind here, and only the run directory tells an unknown run from a missing blob.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { EvidenceBlobReaderPort } from '@vostride/agent-qa-agent'
import type { EvidenceBlobLookup, EvidenceBlobPresence, RunId } from '@vostride/agent-qa-schema'
import { FsEvidenceArtifactStore, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'

/** The lowercase 64-hex shape a content address has. The store's own rule, checked before it. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

export interface CreateEvidenceBlobReaderInput {
  /** The runtime root, i.e. `<configDir>/.agent-qa` — the parent of `runs/`. */
  readonly agentQaRoot: string
}

/**
 * THE LOOKUP — one run, one sha, three answers. Synchronous, because the store is.
 *
 * THIS IS THE SHARED RULE, and both consumers below are shapings of it. The analysis job wants
 * bytes-or-nothing and the op wants the three-arm split; writing the rule once and adapting it
 * twice is what keeps "where does a blob live" a single sentence in this repository.
 *
 * The regex guard is deliberately redundant with `RunsArtifactInputSchema`: the schema already
 * refused every malformed sha before the op ran, so that branch is unreachable through the shipped
 * path. It stays because an in-layer caller has no schema in front of it, and the alternative to
 * guarding here is handing an unchecked string on toward a `join` — which is the one thing a port
 * implementation may never do, reachable or not.
 */
function runDirectoryExists(input: CreateEvidenceBlobReaderInput, runId: string): boolean {
  // THE RUN-EXISTENCE QUESTION, asked of the directory rather than of a handoff: a run that is
  // mid-flight has a directory and no `handoff.json`, and answering `unknown_run` for it would
  // make a live run's screenshots read as a broken link.
  //
  // ONE FUNCTION RATHER THAN TWO SPELLINGS, because the read and the stat below are the same rule
  // at two costs: a second `existsSync` here is a second definition of what a known run IS, and
  // the day one of them learns about a new layout the other reports a live run as unknown.
  return existsSync(join(input.agentQaRoot, RUNS_SUBDIR, slugBranch(runId)))
}

export function lookupEvidenceBlob(
  input: CreateEvidenceBlobReaderInput,
  runId: string,
  sha: string,
): EvidenceBlobLookup {
  if (!SHA256_HEX_RE.test(sha)) return { status: 'blob_absent' }
  if (!runDirectoryExists(input, runId)) return { status: 'unknown_run' }
  const bytes = new FsEvidenceArtifactStore({ root: input.agentQaRoot, runId }).getBlob(sha)
  return bytes === undefined ? { status: 'blob_absent' } : { status: 'found', bytes }
}

// The lookup's split, but a stat instead of a read, so annotating refs loads no screenshots.
export function statEvidenceBlob(
  input: CreateEvidenceBlobReaderInput,
  runId: string,
  sha: string,
): EvidenceBlobPresence {
  if (!SHA256_HEX_RE.test(sha)) return 'blob_absent'
  if (!runDirectoryExists(input, runId)) return 'unknown_run'
  return new FsEvidenceArtifactStore({ root: input.agentQaRoot, runId }).hasBlob(sha)
    ? 'found'
    : 'blob_absent'
}

export function statEvidenceBlobSize(
  input: CreateEvidenceBlobReaderInput,
  runId: string,
  sha: string,
): Awaited<ReturnType<NonNullable<EvidenceBlobReaderPort['stat']>>> {
  if (!SHA256_HEX_RE.test(sha)) return { status: 'blob_absent' }
  if (!runDirectoryExists(input, runId)) return { status: 'unknown_run' }
  const byteLength = new FsEvidenceArtifactStore({ root: input.agentQaRoot, runId }).blobSize(sha)
  return byteLength === undefined ? { status: 'blob_absent' } : { status: 'found', byteLength }
}

export function readEvidenceBlobRange(
  input: CreateEvidenceBlobReaderInput,
  runId: string,
  sha: string,
  start: number,
  end: number,
): EvidenceBlobLookup {
  if (!SHA256_HEX_RE.test(sha)) return { status: 'blob_absent' }
  if (!runDirectoryExists(input, runId)) return { status: 'unknown_run' }
  const bytes = new FsEvidenceArtifactStore({ root: input.agentQaRoot, runId }).readBlobRange(sha, start, end)
  return bytes === undefined ? { status: 'blob_absent' } : { status: 'found', bytes }
}

// Async though the store is not, because a host without local blobs must satisfy the same port.
export function createEvidenceBlobReader(
  input: CreateEvidenceBlobReaderInput,
): EvidenceBlobReaderPort {
  return {
    read: (runId: RunId, sha: string): Promise<EvidenceBlobLookup> =>
      Promise.resolve(lookupEvidenceBlob(input, String(runId), sha)),
    has: (runId: RunId, sha: string): Promise<EvidenceBlobPresence> =>
      Promise.resolve(statEvidenceBlob(input, String(runId), sha)),
    stat: (runId, sha) => Promise.resolve(statEvidenceBlobSize(input, String(runId), sha)),
    readRange: (runId, sha, start, end) =>
      Promise.resolve(readEvidenceBlobRange(input, String(runId), sha, start, end)),
  }
}

/**
 * The analysis job's shaping: the bytes, or nothing, with the two absences collapsed.
 *
 * THE COLLAPSE IS THIS CALLER'S, not the rule's. An evidence-diet pass has the same work to do
 * whether a run is unknown or its blob was already collected — there is no screenshot either way —
 * so it takes the narrower answer rather than making the shared rule narrower for everyone.
 */
export function readEvidenceBlobBytes(
  input: CreateEvidenceBlobReaderInput,
  runId: string,
  sha: string,
): Uint8Array | undefined {
  const lookup = lookupEvidenceBlob(input, runId, sha)
  return lookup.status === 'found' ? lookup.bytes : undefined
}
