// Per-job checkpoint files for the agent job queue.
//
// Under the hybrid split, sqlite owns the job LIFECYCLE and each checkpoint is its own file
// under `.agent-qa/agent-jobs/checkpoints/<jobId>/<checkpointId>.json`. Three reasons, in
// order of weight: JOBQ-05 asks literally for a rename with a parent-directory fsync;
// authored model output can be large and does not belong in a row a claim transaction has
// to move past; and a checkpoint that guards a filesystem side effect should be durable in
// the same medium as the thing it guards, or the two can disagree after a crash.
//
// The publish sequence and its error allowlist are generalized verbatim from v51's
// per-candidate intent journal (knowledge-local, journal/intent-journal.ts). It is not
// reinvented here: the allowlist below encodes platform quirks already debugged once, and
// re-deriving it by hand is how a directory fsync silently becomes best-effort everywhere.
//
// 385 plan 03 added the OBSERVATION SEAM the ordering proof needs. Killing a process does
// not drop the pages the kernel already holds, so a publisher missing an fsync passes every
// crash test run on one machine; the only way to know the sequence is right is to watch the
// calls. The seam is deliberately shaped so it cannot become a way to skip a sync in
// production: `CreateJobCheckpointStoreOptions` has no filesystem member, so no production
// call site has anywhere to put one, and the seam factory is a second exported function that
// a test names explicitly. A test asserts nothing outside `__tests__` ever calls it.

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import {
  canonicalJson,
  asJobId,
  JOB_CHECKPOINT_SCHEMA_VERSION,
  jobCheckpointEnvelopeSchema,
} from '@vostride/agent-qa-schema'
import type { JobCheckpointEnvelope } from '@vostride/agent-qa-schema'

import {
  InvalidJobCheckpointIdError,
  JobCheckpointSchemaVersionError,
} from './store-errors.js'

/** Directory segments under the agent-qa root, per the D-21 "agent job queue" naming. */
export const JOB_CHECKPOINT_SUBDIR = ['agent-jobs', 'checkpoints'] as const

/**
 * Ids that are safe as a single path segment.
 *
 * Leading dots are excluded, so `..` cannot be an id at all, and the class admits no
 * separator on any platform.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * The errno set a parent-directory fsync may legitimately fail with.
 *
 * Copied code for code from v51 rather than re-derived. Each entry is a platform or
 * filesystem on which syncing a directory descriptor is either unsupported or meaningless;
 * anything else is a real I/O failure and must not be swallowed, or the "best effort" in
 * `bestEffortFsyncDirectory` quietly becomes "no effort" everywhere.
 */
export const DIRECTORY_FSYNC_SWALLOWED_CODES = [
  'ENOENT',
  'EINVAL',
  'EISDIR',
  'EPERM',
  'ENOTSUP',
] as const

/**
 * Exactly the filesystem calls this module makes, and nothing else.
 *
 * Narrow on purpose. A wide facade invites a test to answer on its own behalf; this one is
 * small enough that the only reasonable implementation besides the real functions is a
 * recorder that calls through to them.
 */
export interface JobCheckpointFs {
  mkdirSync(path: string, options: { readonly recursive: true }): void
  openSync(path: string, flags: 'wx' | 'r'): number
  writeFileSync(fd: number, data: string, encoding: 'utf8'): void
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  rmSync(path: string, options: { readonly force: true }): void
  readFileSync(path: string, encoding: 'utf8'): string
}

/** The production implementation, frozen so it cannot be patched from a distance. */
export const REAL_JOB_CHECKPOINT_FS: JobCheckpointFs = Object.freeze({
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  readFileSync,
})

export interface JobCheckpointStore {
  publish(jobId: string, checkpointId: string, payload: unknown): void
  read(jobId: string, checkpointId: string): { found: false } | { found: true; payload: unknown }
  /**
   * Remove one published checkpoint file.
   *
   * The file is a CACHE of the fenced sqlite record, and this verb exists only so the cache
   * cannot outlive the record it caches: an operator requeue deletes the authoritative rows,
   * and a file left behind would keep answering the logical dump's digest with a checkpoint
   * no row backs. It never affects recovery in either direction — `readCheckpoint` finds no
   * row and answers `found: false` before it ever consults a file — so a discard that failed
   * to happen would be a dump artifact, not a resumed stand-in.
   *
   * Exactly one file, never a directory and never recursively. An empty per-job directory is
   * harmless and keeping it that way keeps the filesystem facade as narrow as it is.
   */
  discard(jobId: string, checkpointId: string): void
  /** Exposed so a test can assert on the real file, not on a reader that could agree. */
  checkpointPath(jobId: string, checkpointId: string): string
  /** The directory the deterministic logical dump digests. */
  readonly checkpointsRoot: string
}

/**
 * What a production caller supplies: a root, and nothing else.
 *
 * The absence here is the guarantee. There is no filesystem member, so "publish without the
 * fsync" is not a one-argument change any composition root could make by accident.
 */
export interface CreateJobCheckpointStoreOptions {
  /** Absolute path to the agent-qa runtime root, typically `<project>/.agent-qa`. */
  readonly root: string
}

function requireSegment(field: 'jobId' | 'checkpointId', value: string): string {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new InvalidJobCheckpointIdError(field, value)
  }
  return value
}

function checkpointPath(root: string, jobId: string, checkpointId: string): string {
  if (!isAbsolute(root)) throw new TypeError('agent job checkpoint root must be absolute')
  return join(root, ...JOB_CHECKPOINT_SUBDIR, requireSegment('jobId', jobId),
    `${requireSegment('checkpointId', checkpointId)}.json`)
}

function readEnvelopeOn(
  fs: Pick<JobCheckpointFs, 'readFileSync'>,
  root: string,
  jobId: string,
  checkpointId: string,
): { found: false } | { found: true; envelope: JobCheckpointEnvelope } {
  const file = checkpointPath(root, jobId, checkpointId)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false }
    throw error
  }
  const raw = JSON.parse(text) as { schemaVersion?: unknown } | null
  // Preserve the named version refusal before structural validation.
  if (raw?.schemaVersion !== JOB_CHECKPOINT_SCHEMA_VERSION) {
    throw new JobCheckpointSchemaVersionError(file, raw?.schemaVersion)
  }
  const envelope = jobCheckpointEnvelopeSchema.parse(raw)
  if (envelope.jobId !== jobId || envelope.checkpointId !== checkpointId) {
    throw new TypeError('Agent job checkpoint envelope does not match its address')
  }
  return { found: true, envelope }
}

/** Cold read only: no store construction, directory creation or checkpoint publication. */
export function readJobCheckpointEnvelope(
  options: CreateJobCheckpointStoreOptions,
  jobId: string,
  checkpointId: string,
): { found: false } | { found: true; envelope: JobCheckpointEnvelope } {
  return readEnvelopeOn(REAL_JOB_CHECKPOINT_FS, options.root, jobId, checkpointId)
}

function isSwallowableDirectoryFsyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return DIRECTORY_FSYNC_SWALLOWED_CODES.some((allowed) => allowed === code)
}

export function createJobCheckpointStore(
  options: CreateJobCheckpointStoreOptions,
): JobCheckpointStore {
  return createJobCheckpointStoreOn(REAL_JOB_CHECKPOINT_FS, options)
}

/**
 * The same store over an injected filesystem. TEST SEAM — production uses the factory above.
 *
 * It exists because the syscall ORDER is the durability property and no crash test can
 * observe it. Keeping it a separate function, rather than an optional field on the
 * production options, means a production construction cannot reach it by filling in one more
 * property; a test asserts that no non-test file in the workspace names it.
 */
export function createJobCheckpointStoreOn(
  fs: JobCheckpointFs,
  options: CreateJobCheckpointStoreOptions,
): JobCheckpointStore {
  if (!isAbsolute(options.root)) {
    throw new TypeError('agent job checkpoint root must be absolute')
  }

  const checkpointsRoot = join(options.root, ...JOB_CHECKPOINT_SUBDIR)

  function pathFor(jobId: string, checkpointId: string): string {
    return checkpointPath(options.root, jobId, checkpointId)
  }

  function bestEffortFsyncDirectory(dir: string): void {
    let fd: number | undefined
    try {
      fd = fs.openSync(dir, 'r')
      fs.fsyncSync(fd)
    } catch (error) {
      if (!isSwallowableDirectoryFsyncError(error)) {
        throw error
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }

  return {
    checkpointsRoot,
    checkpointPath: pathFor,

    publish(jobId, checkpointId, payload) {
      const file = pathFor(jobId, checkpointId)
      // Typed as the shipped envelope contract rather than as an ad-hoc literal (385 plan
      // 02): the bytes this writes are the bytes the contract describes, so a field added on
      // one side and forgotten on the other stops compiling instead of shipping.
      const envelope: JobCheckpointEnvelope = {
        schemaVersion: JOB_CHECKPOINT_SCHEMA_VERSION,
        jobId: asJobId(jobId),
        checkpointId,
        payload,
      }
      fs.mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp-${randomUUID()}`
      let fd: number | undefined
      try {
        // Exclusive create, so a torn temporary from an earlier crash can never be mistaken
        // for this one's; then fsync the fd BEFORE the rename, so the rename can only
        // publish bytes that are already on the device.
        fd = fs.openSync(temporary, 'wx')
        fs.writeFileSync(fd, `${canonicalJson(envelope)}\n`, 'utf8')
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
        fs.renameSync(temporary, file)
        // The rename itself is a directory mutation, and a directory entry is not durable
        // until its parent is synced — this is the line JOBQ-05 names.
        bestEffortFsyncDirectory(dirname(file))
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
        fs.rmSync(temporary, { force: true })
      }
    },

    discard(jobId, checkpointId) {
      // `pathFor` validates BOTH segments against `SAFE_PATH_SEGMENT` before they are joined,
      // so a crafted id is refused by name rather than reaching `rmSync` as a traversal.
      fs.rmSync(pathFor(jobId, checkpointId), { force: true })
    },

    read(jobId, checkpointId) {
      const read = readEnvelopeOn(fs, options.root, jobId, checkpointId)
      return read.found ? { found: true, payload: read.envelope.payload } : read
    },
  }
}
