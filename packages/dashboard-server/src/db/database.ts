import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { MIGRATIONS, SCHEMA_VERSION, type DashboardMigration } from './schema.js'
import {
  completeRunOwnership,
  defaultRunOwnership,
  orphanSummary,
  type RunOwner,
  type RunOwnership,
  type RunOwnershipInput,
} from './run-owner.js'
import {
  DEFAULT_AGENT_QA_RUNS_DB_PATH,
  generateRunId,
  type RunAttributes,
} from '@vostride/agent-qa-core'
import {
  createDashboardSqliteDatabase,
  type DashboardSqliteDatabase,
} from './sqlite.js'
import { memberOutcomeClass, runStatusClass, type RunStatusClass } from './run-status-class.js'
import {
  RUN_ARTIFACT_SCHEMA_VERSION,
  ModelUsageSchema,
  type ModelUsage,
  RunStepTokenUsageSchema,
  type RunDetailMember,
  type RunDetailRows,
  type RunDetailStep,
  type RunDetailSubAction,
  type RunArtifactFinalizeInput,
  type RunArtifactKind,
  type RunArtifactPayload,
  type RunArtifactStageInput,
  type RunStatus,
} from '@vostride/agent-qa-schema'

const DASHBOARD_DB_PATH_FALLBACK = DEFAULT_AGENT_QA_RUNS_DB_PATH || '.agent-qa/runs.db'

// a suite's history is every run with a member in that suite.
const MEMBER_SUITE_CONDITION = 'id IN (SELECT run_id FROM run_members WHERE suite_id = ?)'

// a test's history is every run with a member of that test id or path.
function memberTestMatch(test: TestRef): { sql: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (test.testId) { clauses.push('test_id = ?'); params.push(test.testId) }
  if (test.filePath) { clauses.push('file_path = ?'); params.push(test.filePath) }
  if (clauses.length === 0) throw new Error('A test is named by its testId or filePath')
  return { sql: `(${clauses.join(' OR ')})`, params }
}

export interface RunRow {
  id: string
  name: string
  filePath: string | null
  status: string
  priority: number
  duration: number
  attributes: RunAttributes
  environment: string | null
  metadata: Record<string, unknown> | null
  startedAt: string | null
  endedAt: string | null
  failureSummary: string | null
  errorLog: string | null
  testId: string | null
  suiteId: string | null
  platform: string
  testFileContent: string | null
  modelName: string | null
  llmProvider: string | null
  parallel: boolean
  createdAt: string
  members?: RunMemberSummary[]
  memberOutcome?: string | null
}

export interface TestRef {
  testId?: string
  filePath?: string
}

export interface RunMemberSummary {
  testIndex: number
  testId: string | null
  filePath: string | null
  suiteId: string | null
  name: string | null
  outcome: string | null
}

export interface RunArtifactRow {
  runId: string
  kind: RunArtifactKind
  schemaVersion: number
  payload: RunArtifactPayload
  finalizedAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * ONE RUN'S ARTIFACT, AND NOTHING ELSE.
 *
 * `children` stood here and is gone. It walked the run row's now-deleted parent link for the child
 * rows of a suite parent — a shape nothing has written since 402-09 put ONE `runs` row per run and moved member
 * identity onto `run_members`. A structurally-always-empty array on a response is worse than an
 * absent one: a reader cannot tell "this run has no children" from "children stopped being a fact
 * this product records", so the page renders an empty section forever and nobody notices.
 */
export interface RunArtifactBundle {
  artifact: RunArtifactRow | null
}

interface ExecutionLogRow {
  id: string
  runId: string
  stepId: string | null
  /**
   * where in the run tree this hook ran, from `HookFinishedPayload`'s own optional
   * fields. `null` means a RUN-SCOPED hook — a real state, not a missing value.
   */
  testIndex: number | null
  stepIndex: number | null
  type: 'hook' | 'appium-script' | 'runjs'
  name: string
  hookId: string | null
  phase: 'setup' | 'teardown' | 'inline'
  status: 'passed' | 'failed'
  duration: number
  stdout: string | null
  stderr: string | null
  returnData: unknown | null
  variables: Record<string, string> | null
  createdAt: string
}

interface InsertExecutionLogInput {
  id: string
  runId: string
  stepId?: string | null
  /** the handle and step this hook belongs to; absent means run-scoped. */
  testIndex?: number | null
  stepIndex?: number | null
  type: 'hook' | 'appium-script' | 'runjs'
  name: string
  hookId?: string | null
  phase: 'setup' | 'teardown' | 'inline'
  status: 'passed' | 'failed'
  duration: number
  stdout?: string | null
  stderr?: string | null
  returnData?: unknown | null
  variables?: Record<string, string> | null
}

interface RunsFilter {
  statuses?: readonly string[]
  name?: string
  platform?: string
  from?: string
  to?: string
  attributePredicates?: AttributePredicate[]
  limit?: number
  offset?: number
}

interface StatsOptions {
  from?: string
  to?: string
  attributePredicates?: AttributePredicate[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMergeRecord(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'schemaVersion') continue
    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMergeRecord(current, value)
      : value
  }
  return merged
}

function mergeArtifactPayload(base: RunArtifactPayload, patch: RunArtifactStageInput): RunArtifactPayload {
  const merged = deepMergeRecord(base as unknown as Record<string, unknown>, patch as Record<string, unknown>)
  merged.schemaVersion = RUN_ARTIFACT_SCHEMA_VERSION
  return merged as unknown as RunArtifactPayload
}

export type InsightsBreakdownDimension = 'test' | 'suite' | 'platform'

export interface InsightsBreakdownRow {
  key: string
  label: string
  runs: number
  passRate: number | null
  flakeRate: number
  avgDuration: number
  passed: number
  failed: number
  filePath?: string
  suiteId?: string
}

/**
 * What a run deletion removed.
 *
 * ROWS ONLY. The two path arrays that stood here fed the router's filesystem cleanup, and both the
 * cleanup and the columns it read are gone: refs are the only artifact addressing now, and the run
 * directory under `.agent-qa/runs/` is the run's own record — the event log and the blobs — which
 * the dashboard never owned and must not delete. `deletedRunIds` survives as a one-element list
 * rather than collapsing to a boolean, because it is the shape the response already publishes.
 */
export interface DeleteRunResult {
  deleted: boolean
  deletedRunIds: string[]
}

export interface AttributePredicate {
  key: string
  value: string
  mode: 'exact' | 'regex'
}

export interface AttributeKeySuggestion {
  key: string
  count: number
}

export interface AttributeValueSuggestion {
  value: string
  count: number
}

// ---- v2 projection row mappers -------------------------------------
//
// THE INVERSE OF THE WRITE AND NOTHING MORE. A column that is NULL becomes an ABSENT key, never a
// `null` and never a substituted default — a reader that had to tell `null` from missing would be
// learning a distinction the bus never made, and the token columns' whole point is that
// unmeasured is absent rather than zero.

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const optionalInt = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined

/** JSON columns are read back with the same permissiveness they were written with. */
function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function mapRunMemberRow(row: Record<string, unknown>): RunDetailMember {
  const outcome = optionalText(row.outcome)
  const recording = parseJsonColumn(row.recording_json)
  return {
    testIndex: row.test_index as number,
    ...(optionalText(row.test_id) === undefined ? {} : { testId: row.test_id as string }),
    ...(optionalText(row.name) === undefined ? {} : { name: row.name as string }),
    ...(optionalText(row.file_path) === undefined ? {} : { filePath: row.file_path as string }),
    ...(optionalText(row.suite_id) === undefined ? {} : { suiteId: row.suite_id as string }),
    ...(optionalText(row.suite_name) === undefined ? {} : { suiteName: row.suite_name as string }),
    ...(optionalInt(row.suite_index) === undefined ? {} : { suiteIndex: row.suite_index as number }),
    ...(optionalInt(row.total_steps) === undefined ? {} : { totalSteps: row.total_steps as number }),
    ...(outcome === undefined ? {} : { outcome: outcome as RunDetailMember['outcome'] }),
    ...(optionalInt(row.duration_ms) === undefined ? {} : { durationMs: row.duration_ms as number }),
    ...(optionalText(row.failure_summary) === undefined
      ? {}
      : { failureSummary: row.failure_summary as string }),
    ...(optionalInt(row.retry_count) === undefined ? {} : { retryCount: row.retry_count as number }),
    attempts: (optionalInt(row.attempts) ?? 1),
    ...(recording === undefined ? {} : { recording: recording as RunDetailMember['recording'] }),
  }
}

// One step's spend carries no per-role split, so a step answered by two models is named by both.
function stepModelName(usage: ModelUsage): string | undefined {
  const roles = [usage.roles.planner, usage.roles.verifier]
  const responding = roles.flatMap((role) => role?.respondingModelIds ?? [])
  const declared = roles.flatMap((role) => (role?.declared === undefined ? [] : [role.declared.modelId]))
  const names = [...new Set(responding.length > 0 ? responding : declared)].sort()
  return names.length > 0 ? names.join(' + ') : undefined
}

function mapRunStepRow(row: Record<string, unknown>): RunDetailStep {
  const evidence = parseJsonColumn(row.evidence_json)
  const variableSnapshot = parseJsonColumn(row.variable_snapshot_json)
  // The model_usage_json column mirrors both optional bus fields, independently.
  // A present envelope owns absence too; malformed JSON must never revive legacy scalar spend.
  const usageEnvelope = parseJsonColumn(row.model_usage_json)
  const modelUsage = isPlainObject(usageEnvelope)
    ? ModelUsageSchema.safeParse(usageEnvelope.modelUsage) : undefined
  const extendedTokens = isPlainObject(usageEnvelope)
    ? RunStepTokenUsageSchema.safeParse(usageEnvelope.tokenUsage) : undefined
  // ALL THREE OR NONE. A row with a total but no prompt count is a write nobody makes; reading it
  // as a partial usage object would let a page render a sum whose parts are missing.
  const totalTokens = optionalInt(row.total_tokens)
  const tokenUsage = row.model_usage_json !== null && row.model_usage_json !== undefined
    ? extendedTokens?.success ? extendedTokens.data : undefined
    : totalTokens === undefined
    ? undefined
    : {
      promptTokens: optionalInt(row.prompt_tokens) ?? 0,
      completionTokens: optionalInt(row.completion_tokens) ?? 0,
      totalTokens,
    }
  return {
    testIndex: row.test_index as number,
    stepIndex: row.step_index as number,
    ...(optionalText(row.step_text) === undefined ? {} : { stepText: row.step_text as string }),
    cacheStatus: row.cache_status as RunDetailStep['cacheStatus'],
    verifierVerdict: (parseJsonColumn(row.verifier_verdict) ?? { pass: false, reasoning: '' }) as RunDetailStep['verifierVerdict'],
    selfHealOccurred: row.self_heal_occurred === 1,
    briefDigest: (optionalText(row.brief_digest) ?? ''),
    ...(optionalText(row.status) === undefined ? {} : { status: row.status as RunDetailStep['status'] }),
    ...(optionalInt(row.duration_ms) === undefined ? {} : { durationMs: row.duration_ms as number }),
    ...(optionalText(row.error) === undefined ? {} : { error: row.error as string }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(modelUsage?.success ? { modelUsage: modelUsage.data } : {}),
    ...(evidence === undefined ? {} : { evidence: evidence as RunDetailStep['evidence'] }),
    ...(variableSnapshot === undefined
      ? {}
      : { variableSnapshot: variableSnapshot as RunDetailStep['variableSnapshot'] }),
  }
}

function mapRunSubActionRow(row: Record<string, unknown>): RunDetailSubAction {
  const grounding = parseJsonColumn(row.grounding)
  const artifactRefs = parseJsonColumn(row.artifact_refs)
  const ariaEvidence = parseJsonColumn(row.evidence_state_json)
  return {
    testIndex: row.test_index as number,
    stepIndex: row.step_index as number,
    subActionIndex: row.sub_action_index as number,
    plan: (optionalText(row.plan) ?? ''),
    plannedAction: parseJsonColumn(row.planned_action) as RunDetailSubAction['plannedAction'],
    ...(grounding === undefined ? {} : { grounding: grounding as RunDetailSubAction['grounding'] }),
    result: parseJsonColumn(row.result) as RunDetailSubAction['result'],
    screenStateHash: (optionalText(row.screen_state_hash) ?? ''),
    ...(optionalText(row.screen_state_hash_after) === undefined
      ? {}
      : { screenStateHashAfter: row.screen_state_hash_after as string }),
    ...(Array.isArray(artifactRefs)
      ? { artifactRefs: artifactRefs as RunDetailSubAction['artifactRefs'] }
      : {}),
    ...(ariaEvidence === undefined
      ? {}
      : { ariaEvidence: ariaEvidence as RunDetailSubAction['ariaEvidence'] }),
    ...(optionalInt(row.recording_offset_ms) === undefined
      ? {}
      : { recordingOffsetMs: row.recording_offset_ms as number }),
  }
}

export function runSqliteMigrations(
  db: DashboardSqliteDatabase,
  migrations: readonly DashboardMigration[],
  schemaVersion: number,
): void {
  if (assertSupportedUserVersion(db, schemaVersion) === schemaVersion) return

  const runnableMigrations = migrations.filter(migration => migration.version <= schemaVersion)
  const terminal = runnableMigrations.length === 1 ? runnableMigrations[0] : undefined
  if (terminal === undefined || terminal.version !== schemaVersion) {
    const found = runnableMigrations.map(migration => migration.version).join(', ')
    throw new Error(
      `Expected exactly 1 SQLite migration at version ${schemaVersion}, `
      + `found ${runnableMigrations.length} at [${found}]`,
    )
  }

  db.pragma('foreign_keys = OFF')
  try {
    // another opener may have stamped the file since the read above.
    const runAll = db.transaction(() => {
      if (assertSupportedUserVersion(db, schemaVersion) === schemaVersion) return
      for (const sql of terminal.sql) {
        db.exec(sql)
      }
      db.pragma(`user_version = ${terminal.version}`)
    }, { immediate: true })
    runAll()
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

class UnsupportedUserVersionError extends Error {
  constructor(
    readonly version: number,
    readonly schemaVersion: number,
  ) {
    super(
      version > schemaVersion
        ? `SQLite database user_version ${version} is not compatible with schema version ${schemaVersion}. `
          + 'Remove the dashboard database or use a compatible agent-qa version.'
        : `SQLite database user_version ${version} predates schema version ${schemaVersion}, `
          + 'and this build performs no migration for that version. '
          + 'Remove the dashboard database or use a compatible agent-qa version.',
    )
    this.name = 'UnsupportedUserVersionError'
  }
}

function assertSupportedUserVersion(db: DashboardSqliteDatabase, schemaVersion: number): number {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  if (currentVersion !== 0 && currentVersion !== schemaVersion) {
    throw new UnsupportedUserVersionError(currentVersion, schemaVersion)
  }
  return currentVersion
}

const SQLITE_BUSY = 5
const WAL_RETRY_STEP_MS = 25
const WAL_RETRY_LIMIT_MS = 5000

// on a fresh file the WAL switch can return SQLITE_BUSY that
// busy_timeout does not absorb; the constructor is synchronous, so the wait is Atomics.wait.
function enableWalMode(db: DashboardSqliteDatabase): void {
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let waited = 0; ; waited += WAL_RETRY_STEP_MS) {
    try {
      db.pragma('journal_mode = WAL')
      return
    } catch (error) {
      const errcode = (error as { errcode?: unknown } | null)?.errcode
      const busy = typeof errcode === 'number' && (errcode & 0xff) === SQLITE_BUSY
      if (!busy || waited >= WAL_RETRY_LIMIT_MS) throw error
      Atomics.wait(pause, 0, 0, WAL_RETRY_STEP_MS)
    }
  }
}

export class RunsDatabaseVersionRefusedError extends Error {
  readonly dbPath: string
  readonly version: number

  constructor(dbPath: string, refusal: UnsupportedUserVersionError) {
    super(
      refusal.version < refusal.schemaVersion
        ? `${dbPath} was written by an older agent-qa (runs database version ${refusal.version}). `
          + 'Delete it and run again; agent-qa creates a new one.'
        : `${dbPath}: ${refusal.message}`,
    )
    this.name = 'RunsDatabaseVersionRefusedError'
    this.dbPath = dbPath
    this.version = refusal.version
  }
}

export class DashboardDatabase {
  private db: DashboardSqliteDatabase
  readonly runOwnership: RunOwnership
  readonly dbPath: string
  private readonly ownStamps = new Map<string, RunOwner>()

  constructor({
    dbPath = DASHBOARD_DB_PATH_FALLBACK,
    runOwnership = defaultRunOwnership(),
  }: { dbPath?: string; runOwnership?: RunOwnershipInput } = {}) {
    this.runOwnership = completeRunOwnership(runOwnership)
    this.dbPath = dbPath === ':memory:' ? dbPath : resolve(dbPath)
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = createDashboardSqliteDatabase(dbPath)
    try {
      this.db.pragma('busy_timeout = 5000')
      // refuse before WAL mode rewrites the file header.
      assertSupportedUserVersion(this.db, SCHEMA_VERSION)
      enableWalMode(this.db)
      this.runMigrations()
    } catch (error) {
      this.db.close()
      if (error instanceof UnsupportedUserVersionError) {
        throw new RunsDatabaseVersionRefusedError(resolve(dbPath), error)
      }
      throw error
    }
  }

  private runMigrations(): void {
    runSqliteMigrations(this.db, MIGRATIONS, SCHEMA_VERSION)
  }

  insertRun(run: {
    id?: string
    name: string
    filePath?: string
    status: string
    duration: number
    attributes?: RunAttributes
    environment?: string
    metadata?: Record<string, unknown>
    startedAt: string
    endedAt: string
    failureSummary?: string
    platform?: string
    testFileContent?: string
    modelName?: string
    llmProvider?: string
    testId?: string
    suiteId?: string
  }): string {
    const id = run.id || generateRunId()
    const owner = run.status === 'running' ? this.readOwnStamp() : undefined
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, name, file_path, status, duration, attributes, environment, metadata, started_at, ended_at, failure_summary, platform, test_file_content, model_name, llm_provider, test_id, suite_id, owner_pid, owner_incarnation, owner_host)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      run.name,
      run.filePath ?? null,
      run.status,
      run.duration,
      JSON.stringify(run.attributes ?? {}),
      run.environment ?? null,
      run.metadata ? JSON.stringify(run.metadata) : null,
      run.startedAt,
      run.endedAt,
      run.failureSummary ?? null,
      run.platform ?? 'web',
      run.testFileContent ?? null,
      run.modelName ?? null,
      run.llmProvider ?? null,
      run.testId ?? null,
      run.suiteId ?? null,
      owner?.pid ?? null,
      owner?.incarnation ?? null,
      owner?.host ?? null,
    )
    if (owner) this.ownStamps.set(id, owner)
    return id
  }

  // one statement that inserts a fresh row or adopts this handle's own
  // running row; any other row is refused and left untouched. An adopt that names no name or
  // attributes keeps the row's own.
  claimRunningRow(id: string, fields: {
    name?: string
    filePath?: string
    attributes?: RunAttributes
    startedAt: string
    platform?: string
    testId?: string
    suiteId?: string
  }): boolean {
    const stamp = this.ownStamps.get(id) ?? this.readOwnStamp()
    const result = this.db.prepare(`
      INSERT INTO runs (id, name, file_path, status, duration, attributes, started_at, ended_at, platform, test_id, suite_id, owner_pid, owner_incarnation, owner_host)
      VALUES (?1, COALESCE(?2, 'run'), ?3, 'running', 0, COALESCE(?4, '{}'), ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT(id) DO UPDATE SET
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        name = COALESCE(?2, runs.name),
        attributes = COALESCE(?4, runs.attributes),
        platform = excluded.platform,
        test_id = COALESCE(excluded.test_id, runs.test_id),
        suite_id = COALESCE(excluded.suite_id, runs.suite_id)
      WHERE runs.status = 'running'
        AND runs.owner_pid = excluded.owner_pid
        AND runs.owner_incarnation IS excluded.owner_incarnation
        AND runs.owner_host = excluded.owner_host
    `).run(
      id,
      fields.name ?? null,
      fields.filePath ?? null,
      fields.attributes === undefined ? null : JSON.stringify(fields.attributes),
      fields.startedAt,
      fields.platform ?? 'web',
      fields.testId ?? null,
      fields.suiteId ?? null,
      stamp.pid,
      stamp.incarnation,
      stamp.host,
    )
    if (Number(result.changes) !== 1) return false
    this.ownStamps.set(id, stamp)
    return true
  }

  updateRun(id: string, updates: {
    name?: string
    status?: string
    duration?: number
    startedAt?: string
    endedAt?: string
    failureSummary?: string
    errorLog?: string
    attributes?: RunAttributes
    platform?: string
    testId?: string
    suiteId?: string
  }): void {
    if (updates.status === 'running') {
      throw new Error('updateRun cannot write status running; claim the row with claimRunningRow')
    }
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status) }
    if (updates.duration !== undefined) { fields.push('duration = ?'); values.push(updates.duration) }
    if (updates.startedAt !== undefined) { fields.push('started_at = ?'); values.push(updates.startedAt) }
    if (updates.endedAt !== undefined) { fields.push('ended_at = ?'); values.push(updates.endedAt) }
    if (updates.failureSummary !== undefined) { fields.push('failure_summary = ?'); values.push(updates.failureSummary) }
    if (updates.errorLog !== undefined) { fields.push('error_log = ?'); values.push(updates.errorLog) }
    if (updates.attributes !== undefined) { fields.push('attributes = ?'); values.push(JSON.stringify(updates.attributes)) }
    if (updates.platform !== undefined) { fields.push('platform = ?'); values.push(updates.platform) }
    if (updates.testId !== undefined) { fields.push('test_id = ?'); values.push(updates.testId) }
    if (updates.suiteId !== undefined) { fields.push('suite_id = ?'); values.push(updates.suiteId) }
    if (fields.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    if (updates.status !== undefined) this.ownStamps.delete(id)
  }

  updateRunMetadata(id: string, updates: {
    attributes?: RunAttributes
    metadata?: Record<string, unknown>
    platform?: string
    testFileContent?: string
    modelName?: string
    llmProvider?: string
  }): void {
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.attributes !== undefined) { fields.push('attributes = ?'); values.push(JSON.stringify(updates.attributes)) }
    if (updates.metadata !== undefined) {
      const existing = this.db.prepare('SELECT metadata FROM runs WHERE id = ?').get(id) as { metadata: string | null } | undefined
      const existingMeta = existing?.metadata ? JSON.parse(existing.metadata) : {}
      const merged = { ...existingMeta, ...updates.metadata }
      fields.push('metadata = ?'); values.push(JSON.stringify(merged))
    }
    if (updates.platform !== undefined) { fields.push('platform = ?'); values.push(updates.platform) }
    if (updates.testFileContent !== undefined) { fields.push('test_file_content = ?'); values.push(updates.testFileContent) }
    if (updates.modelName !== undefined) { fields.push('model_name = ?'); values.push(updates.modelName) }
    if (updates.llmProvider !== undefined) { fields.push('llm_provider = ?'); values.push(updates.llmProvider) }
    if (fields.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  insertPendingRun(run: {
    id?: string
    name: string
    filePath?: string
    attributes?: RunAttributes
    priority?: number
    platform?: string
    testFileContent?: string
    modelName?: string
    llmProvider?: string
    metadata?: Record<string, unknown>
    parallel?: boolean
  }): string {
    const id = run.id || generateRunId()
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, name, file_path, status, priority, duration, attributes, started_at, ended_at, platform, test_file_content, model_name, llm_provider, metadata, parallel)
      VALUES (?, ?, ?, 'pending', ?, 0, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      run.name,
      run.filePath ?? null,
      run.priority ?? 0,
      JSON.stringify(run.attributes ?? {}),
      run.platform ?? 'web',
      run.testFileContent ?? null,
      run.modelName ?? null,
      run.llmProvider ?? null,
      run.metadata ? JSON.stringify(run.metadata) : null,
      run.parallel ? 1 : 0,
    )
    return id
  }

  getNextPendingRun(): RunRow | undefined {
    const row = this.db.prepare(
      'SELECT * FROM runs WHERE status = ? ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT 1'
    ).get('pending') as Record<string, unknown> | undefined
    return row ? this.mapRunRow(row) : undefined
  }

  getPendingRuns(): RunRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM runs WHERE status = ? ORDER BY priority DESC, created_at ASC, rowid ASC'
    ).all('pending') as Record<string, unknown>[]
    return rows.map(r => this.mapRunRow(r))
  }

  updateRunStatus(id: string, status: string): boolean {
    if (status !== 'running') {
      const result = this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id)
      this.ownStamps.delete(id)
      return Number(result.changes) === 1
    }
    // the queue flip moves only a pending row to running.
    const stamp = this.readOwnStamp()
    const result = this.db.prepare(
      "UPDATE runs SET status = 'running', owner_pid = ?, owner_incarnation = ?, owner_host = ? WHERE id = ? AND status = 'pending'",
    ).run(stamp.pid, stamp.incarnation, stamp.host, id)
    if (Number(result.changes) !== 1) return false
    this.ownStamps.set(id, stamp)
    return true
  }

  // ---- The v2 bus-shaped projection ---------------------------------
  //
  // SIX MEMBERS, AND EVERY ONE OF THEM MIRRORS. The columns are the bus payload's own names; the
  // nested objects are `JSON.stringify` of the field verbatim. Nothing in this block decides what
  // a status means, re-derives a duration or fills a token count — a projection that interpreted
  // would be a second opinion about a run the event log already settled.

  /**
   * Write or refresh ONE member row, keyed by the handle `(run_id, test_index)`.
   *
   * AN UPSERT AND NOT TWO WRITES, because the member row is fed by two events at two times:
   * `testStarted` knows the identity fields and `testFinished` knows the outcome — and D-18
   * requires a member whose stream begins with a terminal event to render anyway, so the second
   * one alone has to be able to create the row.
   *
   * ONLY SUPPLIED FIELDS MOVE. `COALESCE(excluded.x, run_members.x)` on every optional column, so
   * a `testFinished` that carries no name cannot blank the name `testStarted` wrote. `attempts` is
   * excluded from the update entirely: it is the D-17 retry ordinal, owned by
   * `incrementRunMemberAttempts`, and an upsert that reset it would erase the fact the header
   * renders.
   */
  upsertRunMember(member: {
    runId: string
    testIndex: number
    testId?: string
    name?: string
    filePath?: string
    suiteId?: string
    suiteName?: string
    suiteIndex?: number
    totalSteps?: number
    outcome?: string
    durationMs?: number
    failureSummary?: string
    retryCount?: number
    recording?: RunDetailMember['recording']
  }): void {
    this.db.prepare(`
      INSERT INTO run_members (
        run_id, test_index, test_id, name, file_path, suite_id, suite_name, suite_index,
        total_steps, outcome, duration_ms, failure_summary, retry_count, recording_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, test_index) DO UPDATE SET
        test_id = COALESCE(excluded.test_id, run_members.test_id),
        name = COALESCE(excluded.name, run_members.name),
        file_path = COALESCE(excluded.file_path, run_members.file_path),
        suite_id = COALESCE(excluded.suite_id, run_members.suite_id),
        suite_name = COALESCE(excluded.suite_name, run_members.suite_name),
        suite_index = COALESCE(excluded.suite_index, run_members.suite_index),
        total_steps = COALESCE(excluded.total_steps, run_members.total_steps),
        outcome = COALESCE(excluded.outcome, run_members.outcome),
        duration_ms = COALESCE(excluded.duration_ms, run_members.duration_ms),
        failure_summary = COALESCE(excluded.failure_summary, run_members.failure_summary),
        retry_count = COALESCE(excluded.retry_count, run_members.retry_count),
        recording_json = COALESCE(excluded.recording_json, run_members.recording_json)
    `).run(
      member.runId,
      member.testIndex,
      member.testId ?? null,
      member.name ?? null,
      member.filePath ?? null,
      member.suiteId ?? null,
      member.suiteName ?? null,
      member.suiteIndex ?? null,
      member.totalSteps ?? null,
      member.outcome ?? null,
      member.durationMs ?? null,
      member.failureSummary ?? null,
      member.retryCount ?? null,
      member.recording === undefined ? null : JSON.stringify(member.recording),
    )
  }

  /**
   * Raise ONE member's attempt ordinal. A no-op when the member row does not exist yet —
   * a retry scheduled before any identity event is a real ordering, and inventing a row here
   * would put a member on the page that nothing has said anything about.
   */
  incrementRunMemberAttempts(runId: string, testIndex: number): void {
    this.db.prepare(
      'UPDATE run_members SET attempts = attempts + 1 WHERE run_id = ? AND test_index = ?',
    ).run(runId, testIndex)
  }

  /**
   * Drop ONE HANDLE's projected step and sub-action rows.
   *
   * SCOPED TO THE HANDLE, which was the whole change from the v1 run-wide step delete this
   * replaced (deleted outright by 405-07's census): that member wiped every step of the RUN on any
   * member's retry, so in a suite the abandoned attempt of test 3 deleted the completed history of
   * tests 0-2. The member row itself survives — its outcome and its attempt count are facts about
   * the member, not about the attempt. So do its setup and teardown hook rows, which run once per
   * member outside the retry loop; only the attempt's `inline` hook rows go.
   */
  deleteMemberProjection(runId: string, testIndex: number): void {
    this.db.prepare('DELETE FROM run_steps WHERE run_id = ? AND test_index = ?').run(runId, testIndex)
    this.db.prepare('DELETE FROM run_sub_actions WHERE run_id = ? AND test_index = ?').run(runId, testIndex)
    this.db.prepare(
      "DELETE FROM execution_logs WHERE run_id = ? AND test_index = ? AND phase = 'inline'",
    ).run(runId, testIndex)
  }

  /**
   * Write ONE finalized step row. `INSERT OR REPLACE` because a re-run of the same handle re-emits
   * the same `(test_index, step_index)` and the LAST attempt is the one the page renders.
   *
   * The three token columns stay NULL when `tokenUsage` is absent — never 0.
   */
  insertRunStep(step: {
    runId: string
    testIndex: number
    stepIndex: number
    stepText?: string
    cacheStatus: string
    verifierVerdict: unknown
    selfHealOccurred: boolean
    briefDigest: string
    status?: string
    durationMs?: number
    error?: string
    tokenUsage?: RunDetailStep['tokenUsage']
    modelUsage?: RunDetailStep['modelUsage']
    evidence?: RunDetailStep['evidence']
    variableSnapshot?: RunDetailStep['variableSnapshot']
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO run_steps (
        run_id, test_index, step_index, step_text, cache_status, verifier_verdict,
        self_heal_occurred, brief_digest, status, duration_ms, error,
        prompt_tokens, completion_tokens, total_tokens, evidence_json, variable_snapshot_json, model_usage_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      step.runId,
      step.testIndex,
      step.stepIndex,
      step.stepText ?? null,
      step.cacheStatus,
      JSON.stringify(step.verifierVerdict ?? null),
      step.selfHealOccurred ? 1 : 0,
      step.briefDigest,
      step.status ?? null,
      step.durationMs ?? null,
      step.error ?? null,
      step.tokenUsage?.promptTokens ?? null,
      step.tokenUsage?.completionTokens ?? null,
      step.tokenUsage?.totalTokens ?? null,
      step.evidence === undefined ? null : JSON.stringify(step.evidence),
      step.variableSnapshot === undefined ? null : JSON.stringify(step.variableSnapshot),
      step.modelUsage === undefined && step.tokenUsage === undefined ? null : JSON.stringify({
        ...(step.modelUsage === undefined ? {} : { modelUsage: step.modelUsage }),
        ...(step.tokenUsage === undefined ? {} : { tokenUsage: step.tokenUsage }),
      } satisfies Pick<RunDetailStep, 'modelUsage' | 'tokenUsage'>),
    )
  }

  /**
   * Write ONE sub-action row. The four nested payload fields are stringified VERBATIM — this
   * method never reaches inside `plannedAction`, `grounding`, `result` or `artifactRefs`.
   */
  insertRunSubAction(subAction: {
    runId: string
    testIndex: number
    stepIndex: number
    subActionIndex: number
    plan: string
    plannedAction: unknown
    grounding?: unknown
    result: unknown
    screenStateHash: string
    screenStateHashAfter?: string
    artifactRefs?: readonly unknown[]
    ariaEvidence?: RunDetailSubAction['ariaEvidence']
    recordingOffsetMs?: RunDetailSubAction['recordingOffsetMs']
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO run_sub_actions (
        run_id, test_index, step_index, sub_action_index, plan, planned_action, grounding,
        result, screen_state_hash, screen_state_hash_after, artifact_refs, evidence_state_json,
        recording_offset_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      subAction.runId,
      subAction.testIndex,
      subAction.stepIndex,
      subAction.subActionIndex,
      subAction.plan,
      JSON.stringify(subAction.plannedAction ?? null),
      subAction.grounding === undefined ? null : JSON.stringify(subAction.grounding),
      JSON.stringify(subAction.result ?? null),
      subAction.screenStateHash,
      subAction.screenStateHashAfter ?? null,
      subAction.artifactRefs === undefined ? null : JSON.stringify(subAction.artifactRefs),
      subAction.ariaEvidence === undefined ? null : JSON.stringify(subAction.ariaEvidence),
      subAction.recordingOffsetMs ?? null,
    )
  }

  /**
   * THE run-detail read. `undefined` when no `runs` row exists — absence is a RESULT here,
   * and turning it into a typed refusal is the `runs.detail` op's job, so the "not found"
   * vocabulary lives in the function layer rather than in this store.
   *
   * A run that exists and projected nothing answers three empty arrays, which is a DIFFERENT fact
   * and stays a different answer.
   */
  readRunDetailRows(runId: string): RunDetailRows | undefined {
    const run = this.db.prepare('SELECT id FROM runs WHERE id = ?').get(runId) as { id: string } | undefined
    if (run === undefined) return undefined

    const memberRows = this.db.prepare(
      'SELECT * FROM run_members WHERE run_id = ? ORDER BY test_index',
    ).all(runId) as Record<string, unknown>[]
    const stepRows = this.db.prepare(
      'SELECT * FROM run_steps WHERE run_id = ? ORDER BY test_index, step_index',
    ).all(runId) as Record<string, unknown>[]
    const subActionRows = this.db.prepare(
      'SELECT * FROM run_sub_actions WHERE run_id = ? ORDER BY test_index, step_index, sub_action_index',
    ).all(runId) as Record<string, unknown>[]

    return {
      runId,
      members: memberRows.map(row => mapRunMemberRow(row)),
      steps: stepRows.map(row => mapRunStepRow(row)),
      subActions: subActionRows.map(row => mapRunSubActionRow(row)),
    }
  }

  private appendAttributePredicateConditions(
    conditions: string[],
    params: unknown[],
    predicates: AttributePredicate[] | undefined,
  ): boolean {
    let hasRegex = false
    for (const predicate of predicates ?? []) {
      if (predicate.mode === 'exact') {
        conditions.push(`EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN json_valid(runs.attributes) THEN runs.attributes ELSE '{}' END) AS run_attr
          WHERE run_attr.key = ? AND run_attr.value = ?
        )`)
        params.push(predicate.key, predicate.value)
      } else {
        hasRegex = true
        conditions.push(`EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN json_valid(runs.attributes) THEN runs.attributes ELSE '{}' END) AS run_attr
          WHERE run_attr.key = ?
        )`)
        params.push(predicate.key)
      }
    }
    return hasRegex
  }

  private applyRegexAttributePredicates(
    runs: RunRow[],
    predicates: AttributePredicate[] | undefined,
  ): RunRow[] {
    const regexPredicates = (predicates ?? []).filter((predicate) => predicate.mode === 'regex')
    if (regexPredicates.length === 0) return runs
    const compiled = regexPredicates.map((predicate) => ({
      key: predicate.key,
      regex: new RegExp(predicate.value),
    }))
    return runs.filter((run) =>
      compiled.every((predicate) => {
        const value = run.attributes[predicate.key]
        return typeof value === 'string' && predicate.regex.test(value)
      }),
    )
  }

  private queryRunsWithAttributePredicates(input: {
    conditions: string[]
    params: unknown[]
    attributePredicates?: AttributePredicate[]
    orderBy?: string
    limit?: number
    offset?: number
  }): RunRow[] {
    const conditions = [...input.conditions]
    const params = [...input.params]
    const hasRegex = this.appendAttributePredicateConditions(conditions, params, input.attributePredicates)
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    let sql = `SELECT * FROM runs ${where} ${input.orderBy ?? 'ORDER BY created_at DESC'}`

    if (!hasRegex && input.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(input.limit)
    }
    if (!hasRegex && input.offset !== undefined) {
      sql += ' OFFSET ?'
      params.push(input.offset)
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    const runs = this.applyRegexAttributePredicates(rows.map(r => this.mapRunRow(r)), input.attributePredicates)
    if (!hasRegex) return this.withMemberExecutionDuration(runs)

    const start = input.offset ?? 0
    const end = input.limit !== undefined ? start + input.limit : undefined
    return this.withMemberExecutionDuration(runs.slice(start, end))
  }

  private buildTrendsFromRuns(
    runs: RunRow[],
    classOf: (run: RunRow) => RunStatusClass | 'skipped' | undefined = (run) => runStatusClass(run.status),
  ): {
    daily: { date: string; passed: number; failed: number; total: number; avgDuration: number }[]
    passRate: number | null
    totalRuns: number
    avgDuration: number
  } {
    const totalRuns = runs.length
    // the rate is pass ÷ (pass + fail); no pass or fail outcome is no rate.
    const decided = runs.filter((run) => {
      const runClass = classOf(run)
      return runClass === 'pass' || runClass === 'fail'
    })
    const passedTotal = decided.filter((run) => classOf(run) === 'pass').length
    const avgDuration = totalRuns > 0
      ? runs.reduce((sum, run) => sum + run.duration, 0) / totalRuns
      : 0
    const byDate = new Map<string, RunRow[]>()
    for (const run of runs) {
      const date = (run.startedAt ?? run.createdAt).slice(0, 10)
      const dayRuns = byDate.get(date)
      if (dayRuns) dayRuns.push(run)
      else byDate.set(date, [run])
    }

    return {
      daily: [...byDate.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, dayRuns]) => {
          const total = dayRuns.length
          return {
            date,
            passed: dayRuns.filter((run) => classOf(run) === 'pass').length,
            failed: dayRuns.filter((run) => classOf(run) === 'fail').length,
            total,
            avgDuration: total > 0 ? dayRuns.reduce((sum, run) => sum + run.duration, 0) / total : 0,
          }
        }),
      passRate: decided.length > 0 ? passedTotal / decided.length : null,
      totalRuns,
      avgDuration,
    }
  }

  getRuns(opts: RunsFilter = {}): RunRow[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (opts.statuses && opts.statuses.length > 0) {
      conditions.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`)
      params.push(...opts.statuses)
    }
    if (opts.name) {
      conditions.push('(name LIKE ? OR id LIKE ?)')
      params.push(`%${opts.name}%`, `%${opts.name}%`)
    }
    if (opts.platform) {
      conditions.push('platform = ?')
      params.push(opts.platform)
    }
    if (opts.from) {
      conditions.push('started_at >= ?')
      params.push(opts.from)
    }
    if (opts.to) {
      conditions.push('started_at <= ?')
      params.push(opts.to)
    }

    return this.withMemberSummaries(this.queryRunsWithAttributePredicates({
      conditions,
      params,
      attributePredicates: opts.attributePredicates,
      orderBy: 'ORDER BY created_at DESC',
      limit: opts.limit,
      offset: opts.offset,
    }))
  }

  // one batched member read per 400 returned rows, after pagination.
  private withMemberSummaries(runs: RunRow[]): RunRow[] {
    for (let offset = 0; offset < runs.length; offset += 400) {
      const batch = runs.slice(offset, offset + 400)
      const rows = this.db.prepare(`
        SELECT run_id, test_index, test_id, file_path, suite_id, name, outcome FROM run_members
        WHERE run_id IN (${batch.map(() => '?').join(',')})
        ORDER BY run_id, test_index
      `).all(...batch.map(run => run.id)) as Array<{
        run_id: string
        test_index: number
        test_id: string | null
        file_path: string | null
        suite_id: string | null
        name: string | null
        outcome: string | null
      }>
      const byId = new Map<string, RunMemberSummary[]>()
      for (const row of rows) {
        const members = byId.get(row.run_id) ?? []
        members.push({
          testIndex: row.test_index,
          testId: row.test_id,
          filePath: row.file_path,
          suiteId: row.suite_id,
          name: row.name,
          outcome: row.outcome,
        })
        byId.set(row.run_id, members)
      }
      for (const run of batch) run.members = byId.get(run.id) ?? []
    }
    return runs
  }

  readRunOwner(id: string): RunOwner | undefined {
    const row = this.db.prepare(
      'SELECT owner_pid, owner_incarnation, owner_host FROM runs WHERE id = ? AND owner_pid IS NOT NULL',
    ).get(id) as { owner_pid: number; owner_incarnation: string | null; owner_host: string | null } | undefined
    if (row === undefined) return undefined
    return { pid: row.owner_pid, incarnation: row.owner_incarnation, host: row.owner_host ?? '' }
  }

  listRunningRunOwners(): Array<{ id: string; startedAt?: string; owner: RunOwner }> {
    const rows = this.db.prepare(
      "SELECT id, started_at, owner_pid, owner_incarnation, owner_host FROM runs WHERE status = 'running' ORDER BY rowid",
    ).all() as Array<{
      id: string
      started_at: string | null
      owner_pid: number
      owner_incarnation: string | null
      owner_host: string | null
    }>
    return rows.map(row => ({
      id: row.id,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      owner: { pid: row.owner_pid, incarnation: row.owner_incarnation, host: row.owner_host ?? '' },
    }))
  }

  // one compare-and-set on the stamped owner; never read-then-write.
  finalizeOwnRun(id: string, updates: {
    status: RunStatus
    endedAt: string
    duration?: number
    failureSummary?: string
  }): boolean {
    const fields = ['status = ?', 'ended_at = ?']
    const values: unknown[] = [updates.status, updates.endedAt]
    if (updates.duration !== undefined) { fields.push('duration = ?'); values.push(updates.duration) }
    if (updates.failureSummary !== undefined) {
      fields.push('failure_summary = ?')
      values.push(updates.failureSummary)
    }
    const stamp = this.ownStamps.get(id)
    if (stamp === undefined) return false
    const result = this.db.prepare(`
      UPDATE runs SET ${fields.join(', ')}
      WHERE id = ? AND status = 'running' AND owner_pid = ? AND owner_incarnation IS ? AND owner_host = ?
    `).run(...values, id, stamp.pid, stamp.incarnation, stamp.host)
    if (Number(result.changes) !== 1) return false
    this.ownStamps.delete(id)
    return true
  }

  // 2026-10-17 (443-13, GAP-D1; 444-04): no status condition, because the verdict may already have
  // moved the row off running; the owner columns alone decide whose row it is.
  closeOwnRun(id: string, updates: {
    status: RunStatus
    endedAt: string
  }): boolean {
    const stamp = this.ownStamps.get(id) ?? this.readOwnStamp()
    const result = this.db.prepare(`
      UPDATE runs SET status = ?, ended_at = ?
      WHERE id = ? AND owner_pid = ? AND owner_incarnation IS ? AND owner_host = ?
    `).run(updates.status, updates.endedAt, id, stamp.pid, stamp.incarnation, stamp.host)
    if (Number(result.changes) !== 1) return false
    this.ownStamps.delete(id)
    return true
  }

  // 2026-10-16 (442-15, GAP-D2): own is the stamp this handle wrote, so a NULL start time here is
  // this handle's own write, never an inference about another process.
  isOwnStamp(id: string, owner: RunOwner): boolean {
    const stamp = this.ownStamps.get(id)
    return stamp !== undefined
      && stamp.pid === owner.pid
      && stamp.incarnation === owner.incarnation
      && stamp.host === owner.host
  }

  private readOwnStamp(): RunOwner {
    const { pid, incarnation, host } = this.runOwnership.self
    return { pid, incarnation, host }
  }

  finalizeOrphanRun(id: string, owner: RunOwner): boolean {
    const summary = orphanSummary(owner.pid)
    const endedAt = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE runs SET status = 'failed', failure_summary = ?, ended_at = ?,
        duration = COALESCE(
          MAX(0, CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER)),
          duration
        )
      WHERE id = ? AND status = 'running' AND owner_pid = ? AND owner_incarnation IS ? AND owner_host = ?
    `).run(summary, endedAt, endedAt, id, owner.pid, owner.incarnation, owner.host)
    if (Number(result.changes) !== 1) return false
    try {
      const duration = (this.db.prepare('SELECT duration FROM runs WHERE id = ?').get(id) as
        { duration: number } | undefined)?.duration ?? 0
      const artifact = this.getRunArtifact(id)
      if (artifact && !artifact.finalizedAt) {
        this.finalizeRunArtifact(id, {
          errors: [{ code: 'owner-gone', phase: 'orphan-cleanup', message: summary }],
          runtime: { status: 'failed', duration },
        })
      }
    } catch { /* the row is final; the artifact write is best-effort */ }
    return true
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.withMemberExecutionDuration([this.mapRunRow(row)])[0] : undefined
  }

  /** Read-only repair for old last-member totals. Complete measured member work is cumulative,
   * including parallel members; it is neither recording length nor run wall-clock time.
   * Incomplete legacy projections retain their stored fallback. Bound queries to returned rows,
   * after pagination, with one aggregate per batch rather than a lookup for every list row.
   */
  private withMemberExecutionDuration(runs: RunRow[]): RunRow[] {
    for (let offset = 0; offset < runs.length; offset += 400) {
      const batch = runs.slice(offset, offset + 400)
      const totals = this.db.prepare(`
        SELECT run_id, SUM(duration_ms) AS duration FROM run_members
        WHERE run_id IN (${batch.map(() => '?').join(',')})
        GROUP BY run_id
        HAVING COUNT(*) = COUNT(duration_ms) AND MIN(duration_ms) >= 0
      `).all(...batch.map(run => run.id)) as Array<{ run_id: string; duration: number }>
      const byId = new Map(totals.map(row => [row.run_id, row.duration]))
      for (const run of batch) {
        const duration = byId.get(run.id)
        if (duration !== undefined && Number.isFinite(duration)) run.duration = duration
      }
    }
    return runs
  }

  listRunAttributeKeys(opts: { limit?: number; q?: string } = {}): AttributeKeySuggestion[] {
    const limit = opts.limit ?? 50
    const params: unknown[] = []
    const filters: string[] = []
    if (opts.q && opts.q.trim().length > 0) {
      filters.push('run_attr.key LIKE ?')
      params.push(`%${opts.q.trim()}%`)
    }
    params.push(limit)
    const rows = this.db.prepare(`
      SELECT run_attr.key as key, COUNT(*) as count
      FROM runs, json_each(CASE WHEN json_valid(runs.attributes) THEN runs.attributes ELSE '{}' END) AS run_attr
      WHERE ${filters.length > 0 ? `${filters.join(' AND ')} AND` : ''} run_attr.type = 'text'
      GROUP BY run_attr.key
      ORDER BY count DESC, key ASC
      LIMIT ?
    `).all(...params) as Array<{ key: string; count: number }>

    return rows.map((row) => ({ key: row.key, count: row.count }))
  }

  listRunAttributeValues(key: string, opts: { limit?: number; q?: string } = {}): AttributeValueSuggestion[] {
    const limit = opts.limit ?? 50
    const params: unknown[] = [key]
    const filters = ['run_attr.key = ?']
    if (opts.q && opts.q.trim().length > 0) {
      filters.push('run_attr.value LIKE ?')
      params.push(`%${opts.q.trim()}%`)
    }
    params.push(limit)
    const rows = this.db.prepare(`
      SELECT run_attr.value as value, COUNT(*) as count
      FROM runs, json_each(CASE WHEN json_valid(runs.attributes) THEN runs.attributes ELSE '{}' END) AS run_attr
      WHERE ${filters.join(' AND ')}
        AND run_attr.type = 'text'
      GROUP BY run_attr.value
      ORDER BY count DESC, value ASC
      LIMIT ?
    `).all(...params) as Array<{ value: string; count: number }>

    return rows.map((row) => ({ value: row.value, count: row.count }))
  }

  /**
   * Delete ONE run and everything the schema hangs off it.
   *
   * ONE ID, AND THE CASCADE DOES THE REST. This used to open with a recursive `run_tree` CTE that
   * walked the child rows of a suite parent, then hand-delete their step and trace rows in a
   * transaction. Nothing has written a child row since 402-09 — one `runs` row per run, member
   * identity on `run_members` — so the walk could only ever return the one row it was seeded with,
   * and the hand-deletes named tables this schema no longer has. Every table that references a run
   * declares `ON DELETE CASCADE`, so the single statement below is the whole deletion.
   *
   * AND IT TOUCHES NO FILE. The two path arrays it used to collect fed the router's artifact
   * cleanup; both are gone. The run's directory under `.agent-qa/runs/` — its event log and its
   * content-addressed blobs — is the run's own record and is not the dashboard's to remove.
   */
  deleteRun(id: string): DeleteRunResult {
    const changes = this.db.prepare('DELETE FROM runs WHERE id = ?').run(id)
    const deleted = Number(changes.changes ?? 0) > 0
    return {
      deleted,
      deletedRunIds: deleted ? [id] : [],
    }
  }

  insertRunArtifact(input: {
    runId: string
    kind?: RunArtifactKind
    payload?: RunArtifactStageInput
  }): RunArtifactRow {
    const payload = mergeArtifactPayload(
      { schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION },
      input.payload ?? {},
    )
    this.db.prepare(`
      INSERT OR IGNORE INTO run_artifacts (run_id, kind, schema_version, payload)
      VALUES (?, ?, ?, ?)
    `).run(
      input.runId,
      input.kind ?? 'unknown',
      RUN_ARTIFACT_SCHEMA_VERSION,
      JSON.stringify(payload),
    )

    const existing = this.getRunArtifact(input.runId)
    if (!existing) {
      throw new Error(`Run artifact ${input.runId} was not created`)
    }
    if (existing.finalizedAt) return existing

    const updates: string[] = []
    const values: unknown[] = []
    if (input.kind && existing.kind !== input.kind) {
      updates.push('kind = ?')
      values.push(input.kind)
    }
    if (input.payload && Object.keys(input.payload).some((key) => key !== 'schemaVersion')) {
      const merged = mergeArtifactPayload(existing.payload, input.payload)
      updates.push('payload = ?')
      values.push(JSON.stringify(merged))
    }
    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP')
      this.db.prepare(`UPDATE run_artifacts SET ${updates.join(', ')} WHERE run_id = ?`).run(...values, input.runId)
    }

    return this.getRunArtifact(input.runId)!
  }

  stageRunArtifact(runId: string, patch: RunArtifactStageInput): RunArtifactRow {
    const row = this.getRunArtifact(runId)
    if (!row) {
      throw new Error(`Run artifact ${runId} does not exist`)
    }
    if (row.finalizedAt) {
      throw new Error(`Run artifact ${runId} is finalized`)
    }
    const payload = mergeArtifactPayload(row.payload, patch)
    this.db.prepare(`
      UPDATE run_artifacts
      SET payload = ?, updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ?
    `).run(JSON.stringify(payload), runId)
    return this.getRunArtifact(runId)!
  }

  finalizeRunArtifact(runId: string, updates?: RunArtifactFinalizeInput): RunArtifactRow {
    const row = this.getRunArtifact(runId)
    if (!row) {
      throw new Error(`Run artifact ${runId} does not exist`)
    }
    if (row.finalizedAt) return row

    let payload = row.payload
    const finalizedAt = updates?.finalizedAt ?? new Date().toISOString()
    if (updates) {
      const { finalizedAt: _finalizedAt, ...patch } = updates
      payload = mergeArtifactPayload(payload, patch)
    }

    this.db.prepare(`
      UPDATE run_artifacts
      SET payload = ?, finalized_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND finalized_at IS NULL
    `).run(JSON.stringify(payload), finalizedAt, runId)

    return this.getRunArtifact(runId)!
  }

  getRunArtifact(runId: string): RunArtifactRow | null {
    const row = this.db.prepare('SELECT * FROM run_artifacts WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined
    return row ? this.mapRunArtifactRow(row) : null
  }

  getRunArtifactBundle(runId: string): RunArtifactBundle {
    return { artifact: this.getRunArtifact(runId) }
  }

  /**
   * The runs a self-heal happened on.
   *
   * READ OFF `run_steps.self_heal_occurred`, WHICH IS THE SURVIVING HEALING FACT. This scanned the
   * v1 wide step table for `status = 'healed'`; that table had no producer left and its readers
   * went with it. `selfHealOccurred` is the bus payload's own boolean, projected verbatim by the
   * subscriber — so the flake rate below is now computed from what the runner actually reported
   * rather than from a status word a retired projection wrote.
   */
  private getHealedRunIds(runIds: string[]): Set<string> {
    if (runIds.length === 0) return new Set()

    const placeholders = runIds.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT DISTINCT run_id
      FROM run_steps
      WHERE self_heal_occurred = 1
        AND run_id IN (${placeholders})
    `).all(...runIds) as Array<{ run_id: string }>

    return new Set(rows.map((row) => row.run_id))
  }

  private summarizeAnalyticsRuns(
    runs: Array<Pick<RunRow, 'id' | 'status' | 'duration'>>,
    healedRunIds: Set<string>,
  ) {
    const totalRuns = runs.length
    const passed = runs.filter((run) => runStatusClass(run.status) === 'pass').length
    const failed = runs.filter((run) => runStatusClass(run.status) === 'fail').length
    const flaky = runs.filter((run) => run.status === 'healed' || healedRunIds.has(run.id)).length
    const totalDuration = runs.reduce((sum, run) => sum + run.duration, 0)

    return {
      totalRuns,
      passed,
      failed,
      flaky,
      // a group's rate is passed ÷ (passed + failed); neither is no rate.
      passRate: passed + failed > 0 ? passed / (passed + failed) : null,
      flakeRate: totalRuns > 0 ? flaky / totalRuns : 0,
      avgDuration: totalRuns > 0 ? totalDuration / totalRuns : 0,
    }
  }

  private listRunsForInsights(
    dimension: InsightsBreakdownDimension,
    opts: StatsOptions & { limit?: number } = {},
  ): RunRow[] {
    const conditions: string[] = []
    const params: unknown[] = []

    // the parent-link predicate is gone from all three arms because the
    // column is. Each arm used it to mean "top-level rows only", and since 402-09 EVERY row is
    // top-level — one `runs` row per run — so the clause was already a no-op on the `suite` and
    // `platform` arms. The `test` arm's clause meant something else: exclude the suite PARENT rows,
    // whose `name` is a suite's and not a test's. That exclusion is preserved verbatim below.
    if (dimension === 'suite') {
      conditions.push('suite_id IS NOT NULL')
    } else if (dimension !== 'platform') {
      conditions.push('suite_id IS NULL')
    }

    if (opts.from) {
      conditions.push('started_at >= ?')
      params.push(opts.from)
    }
    if (opts.to) {
      conditions.push('started_at <= ?')
      params.push(opts.to)
    }

    return this.queryRunsWithAttributePredicates({
      conditions,
      params,
      attributePredicates: opts.attributePredicates,
      orderBy: 'ORDER BY started_at DESC',
    })
  }

  getStats(opts: StatsOptions = {}): {
    totalRuns: number
    passed: number
    failed: number
    flaky: number
    flakeRate: number
    avgDuration: number
    totalTokens: number
    runs: { date: string; passed: number; failed: number; healed: number; duration: number }[]
  } {
    const runs = this.listRunsForInsights('platform', opts)
    const healedRunIds = this.getHealedRunIds(runs.map((run) => run.id))
    const summary = this.summarizeAnalyticsRuns(runs, healedRunIds)

    const byDay = new Map<string, RunRow[]>()
    for (const run of runs) {
      const date = (run.startedAt ?? run.createdAt).slice(0, 10)
      const dayRuns = byDay.get(date)
      if (dayRuns) {
        dayRuns.push(run)
      } else {
        byDay.set(date, [run])
      }
    }

    const daily = [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, dayRuns]) => {
        const dayHealedRunIds = new Set(
          dayRuns
            .filter((run) => healedRunIds.has(run.id))
            .map((run) => run.id),
        )
        const daySummary = this.summarizeAnalyticsRuns(dayRuns, dayHealedRunIds)

        return {
          date,
          passed: daySummary.passed,
          failed: daySummary.failed,
          healed: daySummary.flaky,
          duration: daySummary.avgDuration,
        }
      })

    const runIds = runs.map((run) => run.id)
    const totalTokens = runIds.length > 0
      ? ((this.db.prepare(`
          SELECT COALESCE(SUM(total_tokens), 0) as total_tokens
          FROM run_steps
          WHERE run_id IN (${runIds.map(() => '?').join(',')})
        `).get(...runIds) as Record<string, unknown>).total_tokens as number) || 0
      : 0

    return {
      totalRuns: summary.totalRuns,
      passed: summary.passed,
      failed: summary.failed,
      flaky: summary.flaky,
      flakeRate: summary.flakeRate,
      avgDuration: summary.avgDuration,
      totalTokens,
      runs: daily,
    }
  }

  getCostStats(opts: StatsOptions = {}): {
    runs: { runId: string; name: string; startedAt: string | null; promptTokens: number; completionTokens: number; totalTokens: number }[]
    totals: { promptTokens: number; completionTokens: number; totalTokens: number }
  } {
    const conditions: string[] = []
    const params: unknown[] = []
    if (opts.from) { conditions.push('r.started_at >= ?'); params.push(opts.from) }
    if (opts.to) { conditions.push('r.started_at <= ?'); params.push(opts.to) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = this.db.prepare(`
      SELECT
        r.id as run_id,
        r.name,
        r.started_at,
        COALESCE(SUM(s.prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(s.completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(s.total_tokens), 0) as total_tokens
      FROM runs r
      LEFT JOIN run_steps s ON s.run_id = r.id
      ${where}
      GROUP BY r.id
      ORDER BY r.started_at DESC
    `).all(...params) as Record<string, unknown>[]

    const runs = rows.map(r => {
      const promptTokens = (r.prompt_tokens as number) || 0
      const completionTokens = (r.completion_tokens as number) || 0
      const totalTokens = (r.total_tokens as number) || 0
      return {
        runId: r.run_id as string,
        name: r.name as string,
        startedAt: r.started_at as string | null,
        promptTokens,
        completionTokens,
        totalTokens,
      }
    })

    const totalPrompt = runs.reduce((sum, r) => sum + r.promptTokens, 0)
    const totalCompletion = runs.reduce((sum, r) => sum + r.completionTokens, 0)
    const totalTotal = runs.reduce((sum, r) => sum + r.totalTokens, 0)

    return {
      runs,
      totals: {
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens: totalTotal,
      },
    }
  }

  insertTokenEvent(event: {
    modelName: string
    promptTokens: number
    completionTokens: number
    source: 'test-run' | 'live-editor'
  }): string {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO token_events (id, model_name, prompt_tokens, completion_tokens, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, event.modelName, event.promptTokens, event.completionTokens, event.source)
    return id
  }

  getTokenEventStats(opts: { from?: string; to?: string } = {}): {
    byModel: { date: string; model: string; promptTokens: number; completionTokens: number }[]
    bySource: Record<string, { promptTokens: number; completionTokens: number }>
    totals: { promptTokens: number; completionTokens: number }
    testRunUnmeasuredSteps: number
  } {
    // test-run usage is the window's run-step tokens plus any legacy `test-run`
    // token event. The two never describe the same step: the last writer of a `test-run` event (the
    // v1 reporter) was deleted in 363-11, before `run_steps` existed, and v1 step rows were
    // never migrated into it. Adding both counts each recorded token once.
    const conditions: string[] = []
    const params: unknown[] = []
    if (opts.from) { conditions.push('created_at >= ?'); params.push(opts.from) }
    if (opts.to) { conditions.push('created_at <= ?'); params.push(opts.to) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const eventByModel = this.db.prepare(`
      SELECT
        DATE(created_at) as date,
        model_name as model,
        SUM(prompt_tokens) as promptTokens,
        SUM(completion_tokens) as completionTokens
      FROM token_events
      ${where}
      GROUP BY DATE(created_at), model_name
      ORDER BY date
    `).all(...params) as { date: string; model: string; promptTokens: number; completionTokens: number }[]

    const bySourceRows = this.db.prepare(`
      SELECT
        source,
        SUM(prompt_tokens) as promptTokens,
        SUM(completion_tokens) as completionTokens
      FROM token_events
      ${where}
      GROUP BY source
    `).all(...params) as { source: string; promptTokens: number; completionTokens: number }[]

    const bySource: Record<string, { promptTokens: number; completionTokens: number }> = {}
    for (const row of bySourceRows) {
      bySource[row.source] = { promptTokens: row.promptTokens, completionTokens: row.completionTokens }
    }

    const totalsRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens
      FROM token_events
      ${where}
    `).get(...params) as { promptTokens: number; completionTokens: number }

    // The window selects runs by `started_at`, as `getStats` and the breakdowns do.
    const stepConditions: string[] = []
    const stepParams: unknown[] = []
    if (opts.from) { stepConditions.push('r.started_at >= ?'); stepParams.push(opts.from) }
    if (opts.to) { stepConditions.push('r.started_at <= ?'); stepParams.push(opts.to) }
    const stepWhere = stepConditions.length > 0 ? `WHERE ${stepConditions.join(' AND ')}` : ''
    const stepRows = this.db.prepare(`
      SELECT
        DATE(COALESCE(r.started_at, r.created_at)) as date,
        r.model_name as runModel,
        s.prompt_tokens as promptTokens,
        s.completion_tokens as completionTokens,
        s.total_tokens as totalTokens,
        s.model_usage_json as usageJson
      FROM run_steps s
      JOIN runs r ON r.id = s.run_id
      ${stepWhere}
    `).all(...stepParams) as {
      date: string | null
      runModel: string | null
      promptTokens: number | null
      completionTokens: number | null
      totalTokens: number | null
      usageJson: string | null
    }[]

    const byModelKey = new Map<string, { date: string; model: string; promptTokens: number; completionTokens: number }>()
    for (const row of eventByModel) byModelKey.set(`${row.date}\u0000${row.model}`, { ...row })
    let stepPrompt = 0
    let stepCompletion = 0
    let measuredSteps = 0
    let unmeasuredSteps = 0
    for (const row of stepRows) {
      const envelope = parseJsonColumn(row.usageJson)
      const modelUsage = isPlainObject(envelope) ? ModelUsageSchema.safeParse(envelope.modelUsage) : undefined
      if (row.totalTokens === null || row.totalTokens === undefined) {
        // A step whose model usage records no call made none: that zero was measured.
        if (modelUsage?.success && modelUsage.data.calls.started === 0) {
          measuredSteps += 1
        } else {
          unmeasuredSteps += 1
        }
        continue
      }
      measuredSteps += 1
      const promptTokens = row.promptTokens ?? 0
      const completionTokens = row.completionTokens ?? 0
      stepPrompt += promptTokens
      stepCompletion += completionTokens
      const model = (modelUsage?.success ? stepModelName(modelUsage.data) : undefined)
        ?? (row.runModel || undefined)
        ?? 'unattributed'
      const date = row.date ?? 'unknown'
      const key = `${date}\u0000${model}`
      const current = byModelKey.get(key) ?? { date, model, promptTokens: 0, completionTokens: 0 }
      current.promptTokens += promptTokens
      current.completionTokens += completionTokens
      byModelKey.set(key, current)
    }
    if (measuredSteps > 0) {
      const legacy = bySource['test-run'] ?? { promptTokens: 0, completionTokens: 0 }
      bySource['test-run'] = {
        promptTokens: legacy.promptTokens + stepPrompt,
        completionTokens: legacy.completionTokens + stepCompletion,
      }
    }

    return {
      byModel: [...byModelKey.values()].sort((left, right) => left.date.localeCompare(right.date)),
      bySource,
      totals: {
        promptTokens: totalsRow.promptTokens + stepPrompt,
        completionTokens: totalsRow.completionTokens + stepCompletion,
      },
      testRunUnmeasuredSteps: unmeasuredSteps,
    }
  }

  /**
   * The window's settled run ids, newest first, capped at `limit`, with their full count, and the
   * count of the window's runs still in flight. A settled run has started and is
   * neither `pending` nor `running`; every other row in the window is in flight. Ids only: the
   * Insights knowledge-change read dispatches each through the agent host.
   */
  listInsightsWindowRunIds(opts: { from?: string; to?: string; limit: number }): { runIds: string[]; total: number; inFlight: number } {
    const conditions: string[] = []
    const params: unknown[] = []
    if (opts.from) { conditions.push('started_at >= ?'); params.push(opts.from) }
    if (opts.to) { conditions.push('started_at <= ?'); params.push(opts.to) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const settled = "status NOT IN ('pending', 'running') AND started_at IS NOT NULL"
    const settledWhere = `WHERE ${[...conditions, settled].join(' AND ')}`
    const counts = this.db.prepare(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(CASE WHEN ${settled} THEN 1 ELSE 0 END), 0) as settled FROM runs ${where}
    `).get(...params) as { cnt: number; settled: number }
    const rows = this.db.prepare(`
      SELECT id FROM runs ${settledWhere} ORDER BY started_at DESC, id DESC LIMIT ?
    `).all(...params, opts.limit) as { id: string }[]
    return { runIds: rows.map((row) => row.id), total: counts.settled, inFlight: counts.cnt - counts.settled }
  }

  getRunsByTest(test: TestRef, opts?: { limit?: number; offset?: number; attributePredicates?: AttributePredicate[] }): RunRow[] {
    const match = memberTestMatch(test)
    return this.withMemberOutcome(this.queryRunsWithAttributePredicates({
      conditions: [`id IN (SELECT run_id FROM run_members WHERE ${match.sql})`],
      params: match.params,
      attributePredicates: opts?.attributePredicates,
      orderBy: 'ORDER BY started_at DESC',
      limit: opts?.limit,
      offset: opts?.offset,
    }), test)
  }

  getRunsByTestCount(test: TestRef, opts?: { attributePredicates?: AttributePredicate[] }): number {
    if (opts?.attributePredicates?.length) {
      return this.getRunsByTest(test, { attributePredicates: opts.attributePredicates }).length
    }
    const match = memberTestMatch(test)
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM runs WHERE id IN (SELECT run_id FROM run_members WHERE ${match.sql})`,
    ).get(...match.params) as { cnt: number }
    return row.cnt
  }

  getTestTrends(test: TestRef, opts?: { from?: string; attributePredicates?: AttributePredicate[] }): {
    daily: { date: string; passed: number; failed: number; total: number; avgDuration: number }[]
    passRate: number | null
    totalRuns: number
    avgDuration: number
  } {
    const match = memberTestMatch(test)
    const conditions = [`id IN (SELECT run_id FROM run_members WHERE ${match.sql})`]
    const params: unknown[] = [...match.params]
    if (opts?.from) {
      conditions.push('started_at >= ?')
      params.push(opts.from)
    }
    const runs = this.withMemberOutcome(this.queryRunsWithAttributePredicates({
      conditions,
      params,
      attributePredicates: opts?.attributePredicates,
      orderBy: 'ORDER BY started_at ASC',
    }), test)
    return this.buildTrendsFromRuns(runs, (run) => memberOutcomeClass(run.memberOutcome ?? null))
  }

  // The first matching member by test index names the run's outcome for this test.
  private withMemberOutcome(runs: RunRow[], test: TestRef): RunRow[] {
    const match = memberTestMatch(test)
    for (let offset = 0; offset < runs.length; offset += 400) {
      const batch = runs.slice(offset, offset + 400)
      const rows = this.db.prepare(`
        SELECT run_id, outcome FROM run_members
        WHERE run_id IN (${batch.map(() => '?').join(',')}) AND ${match.sql}
        ORDER BY run_id, test_index
      `).all(...batch.map(run => run.id), ...match.params) as Array<{ run_id: string; outcome: string | null }>
      const byId = new Map<string, string | null>()
      for (const row of rows) if (!byId.has(row.run_id)) byId.set(row.run_id, row.outcome)
      for (const run of batch) run.memberOutcome = byId.get(run.id) ?? null
    }
    return runs
  }

  getRunsBySuiteId(suiteId: string, opts?: { limit?: number; offset?: number; attributePredicates?: AttributePredicate[] }): RunRow[] {
    return this.queryRunsWithAttributePredicates({
      conditions: [MEMBER_SUITE_CONDITION],
      params: [suiteId],
      attributePredicates: opts?.attributePredicates,
      orderBy: 'ORDER BY started_at DESC',
      limit: opts?.limit,
      offset: opts?.offset,
    })
  }

  getRunsBySuiteIdCount(suiteId: string, opts?: { attributePredicates?: AttributePredicate[] }): number {
    if (opts?.attributePredicates?.length) {
      return this.getRunsBySuiteId(suiteId, { attributePredicates: opts.attributePredicates }).length
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM runs
      WHERE ${MEMBER_SUITE_CONDITION}
    `).get(suiteId) as { cnt: number }
    return row.cnt
  }

  getSuiteTrends(suiteId: string, opts?: { from?: string; attributePredicates?: AttributePredicate[] }): {
    daily: { date: string; passed: number; failed: number; total: number; avgDuration: number }[]
    passRate: number | null
    totalRuns: number
    avgDuration: number
  } {
    const conditions = [MEMBER_SUITE_CONDITION]
    const params: unknown[] = [suiteId]
    if (opts?.from) {
      conditions.push('started_at >= ?')
      params.push(opts.from)
    }
    return this.buildTrendsFromRuns(this.queryRunsWithAttributePredicates({
      conditions,
      params,
      attributePredicates: opts?.attributePredicates,
      orderBy: 'ORDER BY started_at ASC',
    }))
  }

  getInsightsBreakdown(
    dimension: InsightsBreakdownDimension,
    opts: StatsOptions & { limit?: number } = {},
  ): InsightsBreakdownRow[] {
    const runs = this.listRunsForInsights(dimension, opts)
    const healedRunIds = this.getHealedRunIds(runs.map((run) => run.id))
    const grouped = new Map<string, Array<RunRow>>()

    for (const run of runs) {
      const key = dimension === 'suite'
        ? (run.suiteId ?? 'unknown')
        : dimension === 'platform'
          ? (run.platform || 'unknown')
          : run.name

      const groupRuns = grouped.get(key)
      if (groupRuns) {
        groupRuns.push(run)
      } else {
        grouped.set(key, [run])
      }
    }

    const rows = [...grouped.entries()].map(([key, groupRuns]) => {
      const groupHealedRunIds = new Set(
        groupRuns
          .filter((run) => healedRunIds.has(run.id))
          .map((run) => run.id),
      )
      const filePaths = new Set(
        groupRuns
          .map((run) => run.filePath)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      )
      const summary = this.summarizeAnalyticsRuns(groupRuns, groupHealedRunIds)
      const row: InsightsBreakdownRow = {
        key,
        label: key,
        runs: summary.totalRuns,
        passRate: summary.passRate,
        flakeRate: summary.flakeRate,
        avgDuration: summary.avgDuration,
        passed: summary.passed,
        failed: summary.failed,
      }

      if (dimension === 'test' && filePaths.size === 1) {
        row.filePath = [...filePaths][0]
      }

      if (dimension === 'suite') {
        row.suiteId = key
      }

      return row
    })

    rows.sort((left, right) =>
      right.runs - left.runs ||
      right.flakeRate - left.flakeRate ||
      (left.passRate ?? Number.POSITIVE_INFINITY) - (right.passRate ?? Number.POSITIVE_INFINITY) ||
      left.label.localeCompare(right.label),
    )

    const limit = opts.limit ?? 25
    return rows.slice(0, limit)
  }

  // grouped by member file path; only pass- and fail-class outcomes count.
  getFlakyTests(opts?: { minRuns?: number; limit?: number }): {
    name: string; filePath: string | null; totalRuns: number; passRate: number; flakyScore: number
  }[] {
    const minRuns = opts?.minRuns ?? 3
    const limit = opts?.limit ?? 50

    const rows = this.db.prepare(`
      SELECT m.file_path AS file_path, m.name AS name, m.outcome AS outcome
      FROM run_members m JOIN runs r ON r.id = m.run_id
      WHERE m.file_path IS NOT NULL AND m.outcome IS NOT NULL
      ORDER BY m.file_path, r.started_at DESC, r.id DESC, m.test_index DESC
    `).all() as Array<{ file_path: string; name: string | null; outcome: string }>

    const byPath = new Map<string, { name: string | null; classes: Array<'pass' | 'fail'> }>()
    for (const row of rows) {
      const outcomeClass = memberOutcomeClass(row.outcome)
      if (outcomeClass !== 'pass' && outcomeClass !== 'fail') continue
      const entry = byPath.get(row.file_path) ?? { name: null, classes: [] }
      if (entry.name === null && row.name) entry.name = row.name
      entry.classes.push(outcomeClass)
      byPath.set(row.file_path, entry)
    }

    return [...byPath.entries()]
      .filter(([, entry]) => entry.classes.length >= minRuns)
      .map(([filePath, entry]) => {
        let alternations = 0
        for (let i = 1; i < entry.classes.length; i++) {
          if (entry.classes[i] !== entry.classes[i - 1]) alternations++
        }
        const totalRuns = entry.classes.length
        return {
          name: entry.name ?? filePath,
          filePath,
          totalRuns,
          passRate: entry.classes.filter((c) => c === 'pass').length / totalRuns,
          flakyScore: totalRuns > 1 ? alternations / (totalRuns - 1) : 0,
        }
      })
      .sort((a, b) => b.flakyScore - a.flakyScore || a.filePath.localeCompare(b.filePath))
      .slice(0, limit)
  }

  insertExecutionLog(data: InsertExecutionLogInput): void {
    const stmt = this.db.prepare(`
      INSERT INTO execution_logs (id, run_id, step_id, type, name, hook_id, phase, status, duration, stdout, stderr, return_data, variables, test_index, step_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      data.id,
      data.runId,
      data.stepId ?? null,
      data.type,
      data.name,
      data.hookId ?? null,
      data.phase,
      data.status,
      data.duration,
      data.stdout ?? null,
      data.stderr ?? null,
      data.returnData != null ? JSON.stringify(data.returnData) : null,
      data.variables != null ? JSON.stringify(data.variables) : null,
      data.testIndex ?? null,
      data.stepIndex ?? null,
    )
  }

  getExecutionLogs(filter: { runId?: string; stepId?: string; type?: string }): ExecutionLogRow[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.runId) { conditions.push('run_id = ?'); params.push(filter.runId) }
    if (filter.stepId) { conditions.push('step_id = ?'); params.push(filter.stepId) }
    if (filter.type) { conditions.push('type = ?'); params.push(filter.type) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM execution_logs ${where} ORDER BY created_at`).all(...params) as Record<string, unknown>[]
    return rows.map(r => ({
      id: r.id as string,
      runId: r.run_id as string,
      stepId: r.step_id as string | null,
      testIndex: (r.test_index as number | null) ?? null,
      stepIndex: (r.step_index as number | null) ?? null,
      type: r.type as 'hook' | 'appium-script' | 'runjs',
      name: r.name as string,
      hookId: r.hook_id as string | null,
      phase: r.phase as 'setup' | 'teardown' | 'inline',
      status: r.status as 'passed' | 'failed',
      duration: r.duration as number,
      stdout: r.stdout as string | null,
      stderr: r.stderr as string | null,
      returnData: r.return_data ? JSON.parse(r.return_data as string) : null,
      variables: r.variables ? JSON.parse(r.variables as string) : null,
      createdAt: r.created_at as string,
    }))
  }

  close(): void {
    this.db.close()
  }

  private parseRunAttributes(value: unknown): RunAttributes {
    if (typeof value !== 'string' || value.length === 0) return {}
    try {
      const parsed = JSON.parse(value) as unknown
      if (!isPlainObject(parsed)) return {}
      const attributes: RunAttributes = {}
      for (const [key, attrValue] of Object.entries(parsed)) {
        if (typeof attrValue === 'string') attributes[key] = attrValue
      }
      return attributes
    } catch {
      return {}
    }
  }

  private mapRunRow(r: Record<string, unknown>): RunRow {
    return {
      id: r.id as string,
      name: r.name as string,
      filePath: r.file_path as string | null,
      status: r.status as string,
      priority: (r.priority as number) ?? 0,
      duration: r.duration as number,
      attributes: this.parseRunAttributes(r.attributes),
      environment: r.environment as string | null,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : null,
      startedAt: r.started_at as string | null,
      endedAt: r.ended_at as string | null,
      failureSummary: (r.failure_summary as string) ?? null,
      errorLog: (r.error_log as string) ?? null,
      testId: (r.test_id as string) ?? null,
      suiteId: (r.suite_id as string) ?? null,
      platform: (r.platform as string) ?? 'web',
      testFileContent: (r.test_file_content as string) ?? null,
      modelName: (r.model_name as string) ?? null,
      llmProvider: (r.llm_provider as string) ?? null,
      parallel: Boolean(r.parallel),
      createdAt: r.created_at as string,
    }
  }

  private mapRunArtifactRow(r: Record<string, unknown>): RunArtifactRow {
    return {
      runId: r.run_id as string,
      kind: r.kind as RunArtifactKind,
      schemaVersion: r.schema_version as number,
      payload: r.payload ? JSON.parse(r.payload as string) : { schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION },
      finalizedAt: (r.finalized_at as string) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }
  }

}
