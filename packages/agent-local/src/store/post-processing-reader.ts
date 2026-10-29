// Checks the file exists, then opens it read-only, so a status query never creates a queue.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { canonicalJson, CurationSnapshotSchema, guardRunNotification, isJobKind, sha256hex } from '@vostride/agent-qa-schema'
import type { JobConclusionKind, JobStatus, RunNotification } from '@vostride/agent-qa-schema'
import type {
  ChainJobIds,
  JobIdSource,
  PostProcessingChainState,
  PostProcessingJobRow,
  PostProcessingReaderPort,
} from '@vostride/agent-qa-agent'

import {
  AGENT_JOB_STORE_BUSY_TIMEOUT_MS,
  AGENT_JOB_STORE_DB_FILE,
  AGENT_JOB_STORE_USER_VERSION,
  QUARANTINED_UNREADABLE_KIND_REASON,
} from './sqlite-job-store.js'
import { JobStoreSchemaVersionError } from './store-errors.js'
import { readJobCheckpointEnvelope } from './job-checkpoint-store.js'

/** Invalid authoritative checkpoint facts cannot be presented as an empty curation. */
export class CurationSnapshotReadError extends Error {
  override readonly name = 'CurationSnapshotReadError'

  constructor() {
    // No persisted prose or payload values in a read failure: they have not crossed MaskFn.
    super('The recorded curation checkpoint is invalid; its snapshot cannot be read.')
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CurationSnapshotReadError()
  }
  return value as Record<string, unknown>
}

function readCurationSnapshot(
  db: DatabaseSync,
  root: string,
  ids: ChainJobIds,
  runId: string,
): PostProcessingChainState['curationSnapshot'] {
  const checkpointId = 'bundle-committed'
  // Match the store's latest fenced row. Files alone cannot resurrect a requeued checkpoint.
  const row = db.prepare(`SELECT payload_json, payload_digest, attempt FROM job_checkpoints
    WHERE job_id = ? AND checkpoint_id = ? ORDER BY attempt DESC LIMIT 1`)
    .get(String(ids.curateMemory), checkpointId)
  if (row === undefined) return undefined
  try {
    const authoritative: unknown = JSON.parse(String(row.payload_json))
    if (sha256hex(canonicalJson(authoritative)) !== row.payload_digest) {
      throw new CurationSnapshotReadError()
    }
    let payload = authoritative
    try {
      const cached = readJobCheckpointEnvelope({ root }, String(ids.curateMemory), checkpointId)
      if (cached.found && sha256hex(canonicalJson(cached.envelope.payload)) === row.payload_digest) {
        payload = cached.envelope.payload
      }
    } catch {
      // Like sqlite-job-store.readCheckpoint: a damaged cache cannot overrule the fenced row.
    }
    const checkpoint = recordOf(payload)
    if (checkpoint.jobId !== ids.curateMemory || checkpoint.checkpointId !== checkpointId
      || checkpoint.attempt !== Number(row.attempt) || !Number.isInteger(checkpoint.attempt)
      || Number(checkpoint.attempt) < 1 || typeof checkpoint.recordedAt !== 'string'
      || checkpoint.recordedAt.length === 0) throw new CurationSnapshotReadError()
    const value = recordOf(checkpoint.value)
    if (value.curationSnapshot === undefined) return undefined
    const job = db.prepare('SELECT kind, idempotency_key, payload, attempts FROM jobs WHERE id = ?')
      .get(String(ids.curateMemory))
    if (job === undefined || job.kind !== 'curate-memory'
      || job.idempotency_key !== `${ids.analyzeRun}->curate-memory`
      || Number(job.attempts) < Number(checkpoint.attempt)
      || recordOf(JSON.parse(String(job.payload))).runId !== runId
      || value.runId !== runId) throw new CurationSnapshotReadError()
    return CurationSnapshotSchema.parse(value.curationSnapshot)
  } catch {
    throw new CurationSnapshotReadError()
  }
}

export interface CreatePostProcessingReaderOptions {
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. Absolute. */
  readonly agentQaRoot: string
  /**
   * The id source THIS host's queue enqueues through.
   *
   * REQUIRED rather than defaulted to the production digest source, and the requirement is the
   * guarantee: the composition hands the reader the very source it built the queue with, so the
   * ids projected and the ids enqueued cannot be two different derivations. A reader that
   * defaulted would silently address other rows in any composition that configured its own
   * source, and would report `pending` about a chain that had already finished.
   */
  readonly idSource: JobIdSource
}

function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function toRow(row: Record<string, unknown> | undefined): PostProcessingJobRow | undefined {
  if (row === undefined) return undefined
  // The store has no conclusion column; only a complete recorded quarantine landing supports one.
  const conclusionKind: JobConclusionKind | undefined =
    !isJobKind(String(row.kind))
    && row.status === 'failed'
    && row.last_failure_kind === 'permanent'
    && row.last_failure_reason === QUARANTINED_UNREADABLE_KIND_REASON
      ? 'unreadable_kind'
      : undefined
  return {
    status: String(row.status) as JobStatus,
    claimed: row.claimed_at !== null,
    attempts: toNumber(row.attempts),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.claimed_at === null ? {} : { claimedAt: String(row.claimed_at) }),
    ...(row.started_at === null ? {} : { startedAt: String(row.started_at) }),
    ...(conclusionKind === undefined ? {} : { conclusionKind }),
    ...(row.last_failure_kind === null ? {} : { lastFailureKind: String(row.last_failure_kind) }),
    ...(row.last_failure_reason === null ? {} : { lastFailureReason: String(row.last_failure_reason) }),
  }
}

/**
 * Bind the `runs.postprocessing` port over this project's queue database.
 *
 * The port's own contract forbids materializing anything, and this implementation honours it
 * structurally rather than carefully: `existsSync` short-circuits before a handle is
 * constructed, and the handle that would be constructed is read-only, which refuses to create
 * a file even if the check were removed.
 */
export function createPostProcessingReader(
  options: CreatePostProcessingReaderOptions,
): PostProcessingReaderPort {
  const path = join(options.agentQaRoot, AGENT_JOB_STORE_DB_FILE)

  return {
    idSource: options.idSource,

    async readChain(
      ids: ChainJobIds,
      runId: string,
    ): Promise<PostProcessingChainState | undefined> {
      // No database means no chain: `undefined`, not an empty state, and nothing is created.
      if (!existsSync(path)) return undefined

      const db = new DatabaseSync(path, {
        readOnly: true,
        timeout: AGENT_JOB_STORE_BUSY_TIMEOUT_MS,
      })
      try {
        // Another build's database is refused; a never-stamped file reads 0 and is readable, empty.
        const stamped = toNumber(db.prepare('PRAGMA user_version').get()?.user_version)
        if (stamped !== 0 && stamped !== AGENT_JOB_STORE_USER_VERSION) {
          throw new JobStoreSchemaVersionError(path, AGENT_JOB_STORE_USER_VERSION, stamped)
        }

        const selectJob = db.prepare(`
          SELECT kind, status, attempts, created_at, claimed_at, started_at, updated_at,
                 last_failure_kind, last_failure_reason
          FROM jobs WHERE id = ?
        `)
        const notificationRow = db
          .prepare('SELECT payload FROM notifications WHERE run_id = ?')
          .get(runId) as Record<string, unknown> | undefined

        const analyzeRun = toRow(
          selectJob.get(String(ids.analyzeRun)) as Record<string, unknown> | undefined,
        )
        const curateMemory = toRow(
          selectJob.get(String(ids.curateMemory)) as Record<string, unknown> | undefined,
        )
        // Parsed through the schema guard on the way out, like `listNotifications`: the column
        // is bytes another process wrote, and a record that lost a stage must not travel as a
        // `RunNotification` to a surface that renders it.
        const notification: RunNotification | undefined =
          notificationRow === undefined
            ? undefined
            : guardRunNotification(JSON.parse(String(notificationRow.payload)) as unknown)
        const curationSnapshot = readCurationSnapshot(db, options.agentQaRoot, ids, runId)

        // Absent members are OMITTED rather than set undefined, so the state a projection reads
        // says the same thing whether it was built here or by a test's literal.
        return {
          ...(analyzeRun === undefined ? {} : { analyzeRun }),
          ...(curateMemory === undefined ? {} : { curateMemory }),
          ...(notification === undefined ? {} : { notification }),
          ...(curationSnapshot === undefined ? {} : { curationSnapshot }),
        }
      } finally {
        db.close()
      }
    },
  }
}
