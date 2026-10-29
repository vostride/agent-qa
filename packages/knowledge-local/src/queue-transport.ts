import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** Gitignored durable curation transport root. */
export const QUEUE_DIR = 'memory/queue'
/** Pending candidates visible to a drainer. */
export const QUEUED_SUBDIR = 'queued'
/** Lease-partitioned candidates atomically removed from the pending set. */
export const CLAIMED_SUBDIR = 'claimed'
/** Terminally isolated candidates that require operator inspection or repair. */
export const QUARANTINED_SUBDIR = 'quarantined'
/** Durable lifecycle checkpoints keyed by candidate content address. */
export const JOBS_SUBDIR = 'jobs'
/** Provisional fail-closed disk-growth limit for one knowledge scope. */
export const QUEUE_MAX_JOBS_PER_SCOPE = 200
/** Provisional fail-closed candidate emission limit for one source run. */
export const QUEUE_MAX_EMITS_PER_RUN = 50

const SAFE_QUEUE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function assertAbsoluteKnowledgeRoot(knowledgeRoot: string): void {
  if (!isAbsolute(knowledgeRoot)) {
    throw new TypeError('knowledgeRoot must be absolute')
  }
}

function assertQueueSegment(value: string, label: string): void {
  if (!SAFE_QUEUE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${label} must be a safe path segment`)
  }
}

export function queueRoot(knowledgeRoot: string): string {
  assertAbsoluteKnowledgeRoot(knowledgeRoot)
  return join(knowledgeRoot, QUEUE_DIR)
}

export function queuedRoot(knowledgeRoot: string): string {
  return join(queueRoot(knowledgeRoot), QUEUED_SUBDIR)
}

export function claimedRoot(knowledgeRoot: string): string {
  return join(queueRoot(knowledgeRoot), CLAIMED_SUBDIR)
}

export function quarantinedRoot(knowledgeRoot: string): string {
  return join(queueRoot(knowledgeRoot), QUARANTINED_SUBDIR)
}

export function jobsRoot(knowledgeRoot: string): string {
  return join(queueRoot(knowledgeRoot), JOBS_SUBDIR)
}

export function queueStagingRoot(knowledgeRoot: string): string {
  return join(queueRoot(knowledgeRoot), '.staging')
}

export function queuedCandidateDir(knowledgeRoot: string, candidateId: string): string {
  assertQueueSegment(candidateId, 'candidateId')
  return join(queuedRoot(knowledgeRoot), candidateId)
}

export function claimedLeaseDir(knowledgeRoot: string, leaseId: string): string {
  assertQueueSegment(leaseId, 'leaseId')
  return join(claimedRoot(knowledgeRoot), leaseId)
}

export function claimedCandidateDir(
  knowledgeRoot: string,
  leaseId: string,
  candidateId: string,
): string {
  assertQueueSegment(candidateId, 'candidateId')
  return join(claimedLeaseDir(knowledgeRoot, leaseId), candidateId)
}

export function quarantinedCandidateDir(
  knowledgeRoot: string,
  candidateId: string,
): string {
  assertQueueSegment(candidateId, 'candidateId')
  return join(quarantinedRoot(knowledgeRoot), candidateId)
}

export function jobStatePath(knowledgeRoot: string, candidateId: string): string {
  assertQueueSegment(candidateId, 'candidateId')
  return join(jobsRoot(knowledgeRoot), `${candidateId}.state.json`)
}

export function removeEmptyDir(dir: string): void {
  try {
    rmdirSync(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
}

export function durableWrite(file: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'wx')
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function bestEffortFsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM' && code !== 'ENOTSUP') {
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export type PublishStagedQueueEntryOutcome = 'published' | 'coalesced'

/** Publish one fully durable staging directory, coalescing an existing content address. */
export function publishStagedQueueEntry(
  stagingDir: string,
  finalDir: string,
  queueDir: string,
): PublishStagedQueueEntryOutcome {
  mkdirSync(queueDir, { recursive: true })
  try {
    renameSync(stagingDir, finalDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if ((code === 'EEXIST' || code === 'ENOTEMPTY') && existsSync(finalDir)) {
      return 'coalesced'
    }
    throw error
  }
  bestEffortFsyncDirectory(queueDir)
  return 'published'
}
