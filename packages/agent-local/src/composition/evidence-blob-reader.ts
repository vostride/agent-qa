// The evidence-blob read port, bound over the SAME store the runner wrote through.
//
// ONE BINDING, TWO CONSUMERS. Before this file the analysis job's `readEvidenceBlob` was an inline
// lambda at the composition root, and `runs.artifact` would have needed a second one. Two lambdas
// over one store is two answers to "where do this run's blobs live" — they agree on the day the
// second is written, and the first time either side changes a root or a subdirectory they stop.
// So the lambda moved here and both consumers call it.
//
// WHY THIS IS A COMPOSITION FILE AND NOT AN OP. `packages/agent` is storageNeutral: `node:fs` and
// the concrete store are unreachable there by architecture, which is exactly why the op declares a
// PORT and this package fills it. What crosses the boundary is bytes and a three-arm verdict.
//
// THE TWO ABSENCES ARE SEPARATED HERE, AND HERE IS THE ONLY PLACE THEY CAN BE.
// `FsEvidenceArtifactStore.getBlob` answers `undefined` for a malformed sha AND for an ENOENT,
// and the layer above needs to tell an unknown RUN apart from a run holding no such BLOB
// — a bad link from a screenshot the diet collected. The run's own directory is what distinguishes
// them: a run that has started has `runs/<slug(runId)>/` whether or not it has written a handoff
// (RESEARCH Pattern 3), so directory presence is the run-existence question and the store's own
// answer is the blob question.
//
// THIS FILE ASSEMBLES NO PATH FROM CALLER INPUT. The runId becomes a path segment
// exactly once, inside `slugBranch`, which is the shared traversal guard the store's own
// constructor uses — and the sha is regex-checked before it is ever handed on. Containment is the
// store's rule; a second rule here would be a second rule free to be the weaker one.

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

/**
 * THE SAME RULE, MINUS THE BYTES — presence for a whole run's artifact refs.
 *
 * WHY NOT `lookupEvidenceBlob(...).status`: a run page annotates every ref it is about to render,
 * and the read arm loads a screenshot into memory to reach the status it then discards. This
 * shaping walks the identical three-way split — malformed sha, unknown run, then the store's own
 * answer — and asks the store to STAT instead of read. The two arms above `runDirectoryExists`
 * are shared code, not a copy, so `found` here and `found` there are the same claim.
 */
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

/**
 * The op's PORT over {@link lookupEvidenceBlob}.
 *
 * BOTH MEMBERS ARE BOUND HERE (406, D-17): this host holds run directories, so it can honestly
 * answer the optional presence member, and an op reading it gets `present` for every ref rather
 * than the omitted key a host without local storage would leave.
 *
 * ASYNC EVEN THOUGH THE STORE IS NOT, because the port is the shape a host that does not hold its
 * blobs on a local disk would also have to satisfy — and a synchronous contract is one such a host
 * could never implement without lying about it. The local answer is simply already resolved.
 */
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
