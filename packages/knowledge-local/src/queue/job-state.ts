import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { canonicalJson } from '@vostride/agent-qa-schema'
import { z } from 'zod'

import { assertWithinKnowledgeRoot } from '../knowledge-containment.js'
import {
  withCurrentWriterAuthority,
  type CurrentWriterAuthority,
} from '../lease/writer-lease.js'
import {
  claimedCandidateDir,
  claimedLeaseDir,
  jobStatePath,
  jobsRoot,
} from './queue-layout.js'

export const CURATION_JOB_STATE_SCHEMA_VERSION = 2

export type CurationJobLifecycle =
  | 'queued'
  | 'authored'
  | 'bundling'
  | 'committing'
  | 'done'

const jobLifecycleSchema: z.ZodType<CurationJobLifecycle> = z.enum([
  'queued',
  'authored',
  'bundling',
  'committing',
  'done',
])

export const curationJobStateSchema = z
  .object({
    schemaVersion: z.literal(CURATION_JOB_STATE_SCHEMA_VERSION),
    candidateId: z.string().regex(/^[0-9a-f]{64}$/),
    lifecycle: jobLifecycleSchema,
    embedCrashCount: z.number().int().nonnegative().default(0),
    // Opaque transport slot; the authored checkpoint schema validates its contents.
    authored: z.unknown().optional(),
    /** Diagnostic wall-clock metadata only; never identity, ordering, or disposition input. */
    updatedAt: z.string(),
  })
  .strict()

export type CurationJobState = z.infer<typeof curationJobStateSchema>

export interface WriteJobStateOptions {
  knowledgeRoot: string
  candidateId: string
  lifecycle: CurationJobLifecycle
  authority: CurrentWriterAuthority
  embedCrashCount?: number
  authored?: unknown
}

export type ReadJobStateOutcome =
  | { kind: 'absent'; present: false }
  | { kind: 'parsed'; present: true; state: CurationJobState }
  | { kind: 'malformed'; present: true }

export interface PersistAuthoredCheckpointOptions {
  knowledgeRoot: string
  candidateId: string
  authority: CurrentWriterAuthority
  authored: unknown
}

export type PersistAuthoredCheckpointOutcome =
  | { kind: 'persisted'; state: CurationJobState }
  | { kind: 'malformed-state'; present: true }

function bestEffortFsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'ENOENT' &&
      code !== 'EINVAL' &&
      code !== 'EISDIR' &&
      code !== 'EPERM' &&
      code !== 'ENOTSUP'
    ) {
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function removeEmptyDir(dir: string): void {
  try {
    rmdirSync(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
}

function atomicRewrite(file: string, state: CurationJobState): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx')
    writeFileSync(fd, `${canonicalJson(state)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    bestEffortFsyncDirectory(dirname(file))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function removeClaimedCandidate(
  knowledgeRoot: string,
  authority: CurrentWriterAuthority,
  candidateId: string,
): void {
  const leaseDir = claimedLeaseDir(knowledgeRoot, authority.leaseId)
  rmSync(
    claimedCandidateDir(knowledgeRoot, authority.leaseId, candidateId),
    { recursive: true, force: true },
  )
  removeEmptyDir(leaseDir)
}

/** Read a strict lifecycle checkpoint; corrupt bytes remain a typed present signal. */
export function readJobState(
  knowledgeRoot: string,
  candidateId: string,
): ReadJobStateOutcome {
  const file = jobStatePath(knowledgeRoot, candidateId)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return existsSync(file)
      ? { kind: 'malformed', present: true }
      : { kind: 'absent', present: false }
  }

  try {
    const parsed = curationJobStateSchema.safeParse(JSON.parse(raw))
    return parsed.success
      ? { kind: 'parsed', present: true, state: parsed.data }
      : { kind: 'malformed', present: true }
  } catch {
    return { kind: 'malformed', present: true }
  }
}

// Writing done removes the state file and any claimed dir, so absence means done or never existed.
type WriteJobStateWithinCurrentAuthorityOptions = Omit<
  WriteJobStateOptions,
  'authority'
> & { authority: CurrentWriterAuthority }

/** @internal The caller must already hold withCurrentWriterAuthority for this root. */
export function writeJobStateWithinCurrentAuthority(
  opts: WriteJobStateWithinCurrentAuthorityOptions,
): CurationJobState {
  const state = curationJobStateSchema.parse({
    schemaVersion: CURATION_JOB_STATE_SCHEMA_VERSION,
    candidateId: opts.candidateId,
    lifecycle: opts.lifecycle,
    embedCrashCount: opts.embedCrashCount ?? 0,
    ...(opts.authored === undefined ? {} : { authored: opts.authored }),
    updatedAt: new Date().toISOString(),
  })
  const file = jobStatePath(opts.knowledgeRoot, opts.candidateId)
  assertWithinKnowledgeRoot(opts.knowledgeRoot, jobsRoot(opts.knowledgeRoot))
  if (state.lifecycle === 'done') {
    assertWithinKnowledgeRoot(opts.knowledgeRoot, claimedLeaseDir(opts.knowledgeRoot, opts.authority.leaseId))
    rmSync(file, { force: true })
    bestEffortFsyncDirectory(jobsRoot(opts.knowledgeRoot))
    removeClaimedCandidate(opts.knowledgeRoot, opts.authority, opts.candidateId)
    return state
  }

  atomicRewrite(file, state)
  return state
}

export function writeJobState(opts: WriteJobStateOptions): CurationJobState {
  return withCurrentWriterAuthority(
    opts.knowledgeRoot,
    opts.authority,
    () => writeJobStateWithinCurrentAuthority(opts),
  )
}

/** Persist the validated-later authored value before any deterministic bundle mutation begins. */
export function persistAuthoredCheckpoint(
  opts: PersistAuthoredCheckpointOptions,
): PersistAuthoredCheckpointOutcome {
  const current = readJobState(opts.knowledgeRoot, opts.candidateId)
  if (current.kind === 'malformed') return { kind: 'malformed-state', present: true }
  const state = writeJobState({
    knowledgeRoot: opts.knowledgeRoot,
    candidateId: opts.candidateId,
    authority: opts.authority,
    lifecycle: 'authored',
    embedCrashCount: current.kind === 'parsed' ? current.state.embedCrashCount : 0,
    authored: opts.authored,
  })
  return { kind: 'persisted', state }
}
