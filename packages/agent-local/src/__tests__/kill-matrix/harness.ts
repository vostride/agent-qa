// Shared kill-matrix fixtures: the deterministic world, the authoring kinds, and the comparison
// basis (Phase 385 plan 06, D-03/D-09/D-12).
//
// Three things live here because the parent and the spawned children must agree on all of them
// exactly, and a value duplicated on both sides of a process boundary is a value that drifts.
//
// 1. The DETERMINISTIC WORLD. A frozen clock and a derived id source, so two runs of the same job
//    in two different processes produce the same bytes. The clock is frozen rather than stepping on
//    purpose: a stepping clock makes every timestamp a function of how many verbs a run happened to
//    call, and an interrupted history calls a different number of them — which would make the
//    comparison differ for a reason that has nothing to do with recovery.
//
// 2. The AUTHORING KINDS. The five shipped declarations with one field replaced: their handlers.
//    The registry contract — schedules, successors, bounds, backoff, dispositions — is read from
//    `REAL_JOB_KIND_DECLARATIONS` and never restated, so a kind reworked in 388/389 changes the
//    matrix with no harness edit. The handler has to be substituted because the shipped stand-ins
//    publish checkpoints without authoring anything, and a matrix asserting "zero model invocations
//    on resume" over handlers that never invoke a model is satisfied by doing nothing at all. The
//    substitute derives its work from the declaration it was handed, so it too has no list of its
//    own; a test asserts the substitution changed the handler and nothing else.
//    2026-09-02 (Phase 412): five rather than six — the reserved sixth job kind left with the
//    Issue-slot cleanup.
//
// 3. The COMPARISON BASIS. `dumpLogicalState()` is the D-03 instrument and it is exact — which
//    means it also carries the three facts that MUST differ between an interrupted history and an
//    uninterrupted one: the attempt count, the abandoned-claim failure record, and the attempt
//    stamped into a re-authored checkpoint's envelope and authoritative row. Those are the history
//    of how the state was reached, not the state. So the comparison splits them into a separate
//    structure that the matrix asserts EXACT VALUES on, rather than dropping them — a projection whose
//    exclusions are unasserted is a loosened assertion wearing a projection's clothes. The split is
//    also checked for completeness against the database's own catalogue, so a column added later
//    must be classified as outcome or history instead of silently vanishing from both.

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
  /**
   * `verb:side[:jobId]` — the crash role's second point vocabulary (plan 07).
   *
   * Mutually exclusive with `point`: a run that named both would have two hooks racing for the
   * same process and a marker naming whichever won.
   */
  verbPoint: 'AGENT_QA_JOB_KILL_VERB_POINT',
  /**
   * `1` = release abandoned claims before pumping.
   *
   * The crash and control roles do not recover by default, because the twelve derived legs kill
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
  /**
   * `0` = do not adopt the epoch; drive every verb with the fence the env names anyway.
   *
   * This is the stale-FENCE half of D-07. A host that re-adopts is refused by `adoptEpoch` before
   * it touches a row; a host that already holds a fence and only discovers it lost authority at
   * its next mutation is refused at the commit boundary, which is the refusal 386's split-brain
   * test lands on. They are two different guards and only one of them is exercised by adopting.
   */
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

/**
 * The FAKE lease the fencing legs take their token from (D-07).
 *
 * Deliberately fake, and deliberately named as such. 385 proves the store refuses a stale epoch;
 * 386 binds v51's real writer lease as the source of that epoch. Reaching for the real lease here
 * would bind the two phases together at the point the whole 385→386 ordering exists to keep apart,
 * and would make this suite fail for lease reasons rather than store reasons.
 *
 * It is a handle rather than a bare number so a leg reads as "this host holds THIS lease" — the
 * shape 386 replaces, with the same one-method surface the store cares about.
 */
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

/**
 * The handler the matrix drives: author every checkpoint the DECLARATION names, in its order.
 *
 * It reads the schedule off the declaration rather than off a table of its own, which is what makes
 * a kind reworked in a later phase flow through with no edit here. The consumption line is appended
 * BEFORE the authorship call, so the log records which boundaries were entered even for the one the
 * host died inside.
 */
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

/** The same idea inside a checkpoint envelope: the attempt that authored it (plan 01's shape). */
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
  /** The untouched D-03 dump, kept so a leg can show what the two histories disagree about. */
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
