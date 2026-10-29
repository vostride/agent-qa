// Shared by parent and children, so the frozen clock, kinds and comparison basis cannot drift.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { REAL_JOB_KIND_DECLARATIONS } from '@vostride/agent-qa-agent'
import type {
  ClockPort,
  JobIdSource,
  JobKindDeclaration,
  JobStoreFence,
} from '@vostride/agent-qa-agent'
import { asJobId, canonicalJson, sha256hex, sha256hex16 } from '@vostride/agent-qa-schema'
import type { ChainedJobRequest, JobId, JobKind } from '@vostride/agent-qa-schema'

import { JOB_CHECKPOINT_SUBDIR, createJobCheckpointStore } from '../../store/job-checkpoint-store.js'
import { AGENT_JOB_STORE_DB_FILE, createSqliteJobStore } from '../../store/sqlite-job-store.js'
import type { SqliteJobStore } from '../../store/sqlite-job-store.js'
import { authorPromptFor, recordConsumption } from './counting-model.js'

// ---- the environment contract (parent and child read the SAME names) ----------------------------

export const KILL_MATRIX_ENV = Object.freeze({
  /** Gate. Without it the child suite is skipped in an ordinary run. */
  child: 'AGENT_QA_JOB_KILL_CHILD',
  /** Which role to run; an unknown or missing value is refused by name, with no default. */
  role: 'AGENT_QA_JOB_KILL_ROLE',
  /** Absolute agent-qa runtime root the store and checkpoints live under. */
  root: 'AGENT_QA_JOB_KILL_ROOT',
  /** Which kind this leg drives. */
  kind: 'AGENT_QA_JOB_KILL_KIND',
  /** `kind:checkpointId:phase` — the crash role only. */
  point: 'AGENT_QA_JOB_KILL_POINT',
  // `verb:side[:jobId]`, exclusive with `point`, so two hooks never race in one process.
  verbPoint: 'AGENT_QA_JOB_KILL_VERB_POINT',
  /**
   * `1` = release abandoned claims before pumping.
   *
   * The crash and control roles do not recover by default, because the derived legs kill
   * the FIRST host of a job and there is nothing to release. A poison job needs the opposite: each
   * successive host must reclaim the row its predecessor died holding, since `claimNext` never
   * re-offers a claimed row and an unrecovered poison job is stuck rather than looping.
   */
  recover: 'AGENT_QA_JOB_KILL_RECOVER',
  /**
   * `1` = the named crash point is expected to be UNREACHABLE in this run.
   *
   * The inverse of the crash role's own guard. A crash host that completes is normally a vacuous
   * leg, but the terminal attempt of a poison job is exactly the run where the point must not be
   * reached — the bound is spent, so the handler is never invoked and the hook never fires. The
   * child asserts the marker is absent rather than present, so "it stopped crashing" is a claim
   * made from inside the host that was still configured to crash.
   */
  unreached: 'AGENT_QA_JOB_KILL_UNREACHED',
  // Zero: drive every verb with the env's fence without adopting, so the commit boundary refuses.
  adopt: 'AGENT_QA_JOB_KILL_ADOPT',
  /** Where the counting model appends its invocations. */
  invocations: 'AGENT_QA_JOB_KILL_INVOCATIONS',
  /** Where the authoring handler appends the checkpoints it entered, in order. */
  consumption: 'AGENT_QA_JOB_KILL_CONSUMPTION',
  /** Marker the crash child publishes at the crash point, immediately before parking. */
  marker: 'AGENT_QA_JOB_KILL_MARKER',
  /** JSON report the control and resume roles publish on success AND on failure. */
  report: 'AGENT_QA_JOB_KILL_REPORT',
  /** Fence epoch the child adopts. A leg that wants to fence out a killed host raises it. */
  epoch: 'AGENT_QA_JOB_KILL_EPOCH',
  /** Optional JSON payload script (`chain` / `fail`) for the adversarial legs. */
  payload: 'AGENT_QA_JOB_KILL_PAYLOAD',
} as const)

// ---- the deterministic world --------------------------------------------------------------------

/** One instant, everywhere. See the header for why this is frozen rather than stepping. */
export const KILL_MATRIX_INSTANT = '2026-01-01T00:00:00.000Z'

export const KILL_MATRIX_CLOCK: ClockPort = Object.freeze({
  now: (): string => KILL_MATRIX_INSTANT,
})

/** Derived from `(kind, idempotencyKey)`, so both processes address the same row. */
export const KILL_MATRIX_ID_SOURCE: JobIdSource = Object.freeze({
  jobIdFor: (kind: JobKind, idempotencyKey: string): JobId =>
    asJobId(`job_${sha256hex16(`${kind} ${idempotencyKey}`)}`),
})

export const KILL_MATRIX_EPOCH = 1

export function idempotencyKeyFor(kind: JobKind): string {
  return `kill-matrix-${kind}`
}

export function jobIdFor(kind: JobKind): JobId {
  return KILL_MATRIX_ID_SOURCE.jobIdFor(kind, idempotencyKeyFor(kind))
}

export function fenceFor(epoch: number = KILL_MATRIX_EPOCH): JobStoreFence {
  return { epoch }
}

// Fake on purpose: the store's epoch refusal is under test, not the real writer lease.
export interface FakeWriterLease {
  readonly epoch: number
  fence(): JobStoreFence
}

export function fakeWriterLease(epoch: number): FakeWriterLease {
  return { epoch, fence: (): JobStoreFence => ({ epoch }) }
}

// ---- the authoring kinds -------------------------------------------------------------------------

/** What a leg can script the substituted handler to do, beyond authoring its schedule. */
export interface KillMatrixScript {
  readonly chain?: boolean
  readonly fail?: 'retryable' | 'permanent'
  readonly reason?: string
}

export function readKillMatrixScript(payload: unknown): KillMatrixScript {
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as Record<string, unknown>
  const fail = record.fail === 'retryable' || record.fail === 'permanent' ? record.fail : undefined
  return {
    chain: record.chain === true,
    ...(fail === undefined ? {} : { fail }),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  }
}

export interface AuthoringArtifacts {
  readonly invocationsPath: string
  readonly consumptionPath: string
}

// Reads the schedule off the declaration and logs each boundary before authoring it.
function authoringHandler(
  declaration: JobKindDeclaration,
  artifacts: AuthoringArtifacts,
): JobKindDeclaration['handler'] {
  return async (context) => {
    const script = readKillMatrixScript(context.payload)
    for (const checkpointId of declaration.checkpointSchedule) {
      recordConsumption(artifacts.consumptionPath, String(context.job.id), checkpointId)
      await context.recordLlmAuthorship(checkpointId, async (model) => {
        const output = await model.generate({
          prompt: authorPromptFor(declaration.kind, checkpointId),
        })
        return {
          authoredBy: model.modelId,
          checkpointId,
          jobId: String(context.job.id),
          text: output.text,
        }
      })
    }
    if (script.fail !== undefined) {
      return {
        status: script.fail,
        reason: script.reason ?? `${declaration.kind} kill-matrix scripted failure`,
      }
    }
    const next: ChainedJobRequest[] =
      script.chain === true
        ? declaration.allowedSuccessors.map((successor) => ({
            kind: successor,
            payload: { from: declaration.kind, predecessor: String(context.job.id) },
            idempotencyKey: `${String(context.job.id)}->${successor}`,
          }))
        : []
    return { status: 'complete', next }
  }
}

/** The shipped declarations with their handlers replaced and every other field carried through. */
export function authoringDeclarations(
  artifacts: AuthoringArtifacts,
  base: readonly JobKindDeclaration[] = REAL_JOB_KIND_DECLARATIONS,
): readonly JobKindDeclaration[] {
  return base.map((declaration) => ({
    ...declaration,
    handler: authoringHandler(declaration, artifacts),
  }))
}

// ---- the comparison basis ------------------------------------------------------------------------

/**
 * The `jobs` columns that record HOW a state was reached rather than what it is.
 *
 * Every one of them differs by design between an interrupted history and an uninterrupted one, and
 * every one is asserted with an exact expected value by the matrix — they are split out, not
 * dropped.
 */
export const CRASH_HISTORY_JOB_COLUMNS = [
  'attempts',
  'last_failure_kind',
  'last_failure_reason',
] as const

/** The same idea inside a checkpoint envelope: the attempt that authored it. */
export const CRASH_HISTORY_CHECKPOINT_FIELDS = ['attempt'] as const

/**
 * Every source column in the authoritative checkpoint table.
 *
 * `payload_json` is deliberately mixed: its identity/time/value fields describe the outcome while
 * its attempt describes history. `payload_digest` is verified before that payload is split, rather
 * than copied into either half. The matrix compares this list with SQLite's catalogue so a future
 * column cannot disappear from the projection unnoticed.
 */
export const CHECKPOINT_ROW_SOURCE_COLUMNS = [
  'job_id',
  'checkpoint_id',
  'attempt',
  'payload_json',
  'payload_digest',
  'epoch',
] as const

export interface OutcomeTable {
  readonly table: string
  readonly orderBy: readonly string[]
  readonly rows: readonly Record<string, unknown>[]
}

export interface OutcomeCheckpoint {
  readonly path: string
  readonly envelopeSchemaVersion: unknown
  readonly jobId: unknown
  readonly checkpointId: unknown
  readonly recordedAt: unknown
  readonly valueDigest: string
}

export interface KillMatrixOutcomeState {
  readonly schemaVersion: number
  readonly tables: readonly OutcomeTable[]
  readonly checkpoints: readonly OutcomeCheckpoint[]
}

export interface KillMatrixHistory {
  readonly jobs: readonly Record<string, unknown>[]
  readonly checkpoints: readonly Record<string, unknown>[]
  readonly checkpointRows: readonly Record<string, unknown>[]
}

export interface KillMatrixSnapshot {
  // The untouched logical dump, kept so a leg can show what the two histories disagree about.
  readonly logicalDump: string
  readonly outcome: KillMatrixOutcomeState
  /** `canonicalJson(outcome)` — byte equality here is outcome equality. */
  readonly canonicalOutcome: string
  readonly history: KillMatrixHistory
  /** Raw checkpoint file text by path relative to the checkpoint root. */
  readonly checkpointBytes: Readonly<Record<string, string>>
  readonly tableNames: readonly string[]
  readonly jobColumns: readonly string[]
  readonly checkpointColumns: readonly string[]
}

export function checkpointsRootOf(agentQaRoot: string): string {
  return join(agentQaRoot, ...JOB_CHECKPOINT_SUBDIR)
}

/** Every checkpoint file under the root, by path relative to it, sorted. */
export function readCheckpointFiles(agentQaRoot: string): Record<string, string> {
  const root = checkpointsRootOf(agentQaRoot)
  const found: Record<string, string> = {}

  function walk(dir: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      found[relative(root, path).split(sep).join('/')] = readFileSync(path, 'utf8')
    }
  }

  walk(root)
  return found
}

export function openKillMatrixStore(agentQaRoot: string): SqliteJobStore {
  return createSqliteJobStore({
    path: join(agentQaRoot, AGENT_JOB_STORE_DB_FILE),
    clock: KILL_MATRIX_CLOCK,
    checkpoints: createJobCheckpointStore({ root: agentQaRoot }),
  })
}

function splitCheckpointBytes(
  path: string,
  text: string,
): { outcome: OutcomeCheckpoint; history: Record<string, unknown> } {
  const envelope = JSON.parse(text) as Record<string, unknown>
  const record = envelope.payload as Record<string, unknown>
  return {
    outcome: {
      path,
      envelopeSchemaVersion: envelope.schemaVersion,
      jobId: envelope.jobId,
      checkpointId: envelope.checkpointId,
      recordedAt: record.recordedAt,
      valueDigest: sha256hex(canonicalJson(record.value)),
    },
    history: { path, attempt: record.attempt },
  }
}

function splitCheckpointRow(
  row: Record<string, unknown>,
): { outcome: Record<string, unknown>; history: Record<string, unknown> } {
  const payloadJson = String(row.payload_json)
  const expectedDigest = sha256hex(payloadJson)
  if (String(row.payload_digest) !== expectedDigest) {
    throw new Error(
      `checkpoint row digest mismatch for ${String(row.job_id)}/${String(row.checkpoint_id)}`,
    )
  }

  const record = JSON.parse(payloadJson) as Record<string, unknown>
  if (
    String(record.jobId) !== String(row.job_id) ||
    String(record.checkpointId) !== String(row.checkpoint_id) ||
    record.attempt !== row.attempt
  ) {
    throw new Error(
      `checkpoint row identity mismatch for ${String(row.job_id)}/${String(row.checkpoint_id)}`,
    )
  }

  const identity = {
    jobId: row.job_id,
    checkpointId: row.checkpoint_id,
  }
  return {
    outcome: {
      ...identity,
      recordedAt: record.recordedAt,
      valueDigest: sha256hex(canonicalJson(record.value)),
    },
    history: {
      ...identity,
      attempt: row.attempt,
      epoch: row.epoch,
    },
  }
}

/**
 * The state of one store root, split into the outcome and the crash history.
 *
 * Opened and closed here rather than held: the parent reads a root a child wrote, and holding a
 * connection open across a spawn is how a reader ends up comparing a database it is itself keeping
 * a WAL frame alive in.
 */
export async function readStoreSnapshot(agentQaRoot: string): Promise<KillMatrixSnapshot> {
  const store = openKillMatrixStore(agentQaRoot)
  let logicalDump: string
  let tables: readonly OutcomeTable[]
  let tableNames: readonly string[]
  let jobColumns: readonly string[]
  let checkpointColumns: readonly string[]
  let historyJobs: readonly Record<string, unknown>[]
  let historyCheckpointRows: readonly Record<string, unknown>[]
  let schemaVersion: number
  try {
    logicalDump = await store.dumpLogicalState()
    const dump = await store.logicalDump()
    schemaVersion = dump.schemaVersion
    tableNames = dump.tables.map((table) => table.table)
    jobColumns = dump.tables.find((table) => table.table === 'jobs')?.orderBy ?? []
    const checkpointTable = dump.tables.find((table) => table.table === 'job_checkpoints')
    checkpointColumns = checkpointTable?.orderBy ?? []
    const checkpointRows = (checkpointTable?.rows ?? []).map(splitCheckpointRow)
    tables = dump.tables.map((table) => {
      let rows = table.rows
      if (table.table === 'jobs') {
        rows = table.rows.map((row) => {
          const projected: Record<string, unknown> = {}
          for (const [column, value] of Object.entries(row)) {
            if (!CRASH_HISTORY_JOB_COLUMNS.some((history) => history === column)) {
              projected[column] = value
            }
          }
          return projected
        })
      } else if (table.table === 'job_checkpoints') {
        rows = checkpointRows.map((entry) => entry.outcome)
      }
      return { table: table.table, orderBy: table.orderBy, rows }
    })
    historyJobs = (dump.tables.find((table) => table.table === 'jobs')?.rows ?? []).map((row) => {
      const history: Record<string, unknown> = { id: row.id }
      for (const column of CRASH_HISTORY_JOB_COLUMNS) history[column] = row[column]
      return history
    })
    historyCheckpointRows = checkpointRows.map((entry) => entry.history)
  } finally {
    store.close()
  }

  const checkpointBytes = readCheckpointFiles(agentQaRoot)
  const split = Object.entries(checkpointBytes)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, text]) => splitCheckpointBytes(path, text))

  const outcome: KillMatrixOutcomeState = {
    schemaVersion,
    tables,
    checkpoints: split.map((entry) => entry.outcome),
  }

  return {
    logicalDump,
    outcome,
    canonicalOutcome: canonicalJson(outcome),
    history: {
      jobs: historyJobs,
      checkpoints: split.map((entry) => entry.history),
      checkpointRows: historyCheckpointRows,
    },
    checkpointBytes,
    tableNames,
    jobColumns,
    checkpointColumns,
  }
}

/** Open the store, adopt the epoch, enqueue one job of `kind`, close. Returns the row's id. */
export async function seedJob(
  agentQaRoot: string,
  kind: JobKind,
  payload: unknown = {},
): Promise<JobId> {
  const store = openKillMatrixStore(agentQaRoot)
  try {
    const fence = await store.adoptEpoch(KILL_MATRIX_EPOCH)
    const outcome = await store.enqueue({
      id: KILL_MATRIX_ID_SOURCE.jobIdFor(kind, idempotencyKeyFor(kind)),
      kind,
      idempotencyKey: idempotencyKeyFor(kind),
      summary: `agent job ${kind} (${idempotencyKeyFor(kind)})`,
      payload,
    })
    void fence
    return outcome.job.id
  } finally {
    store.close()
  }
}
