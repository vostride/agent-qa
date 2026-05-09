import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS, SCHEMA_VERSION, type DashboardMigration } from './schema.js'
import {
  createBetterSqlite3Database,
  DEFAULT_AGENT_QA_RUNS_DB_PATH,
  generateRunId,
  RUN_ARTIFACT_SCHEMA_VERSION,
  type BetterSqlite3Database,
  type LogEntry,
  type LogStorage,
  type RunArtifactFinalizeInput,
  type RunArtifactKind,
  type RunArtifactPayload,
  type RunArtifactStageInput,
  type RunAttributes,
} from '@vostride/agent-qa-core'

const DASHBOARD_DB_PATH_FALLBACK = DEFAULT_AGENT_QA_RUNS_DB_PATH || '.agent-qa/runs.db'

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
  videoPath: string | null
  failureSummary: string | null
  errorLog: string | null
  memoryLog: string | null
  testId: string | null
  suiteId: string | null
  platform: string
  testFileContent: string | null
  modelName: string | null
  llmProvider: string | null
  parallel: boolean
  parentRunId: string | null
  attemptNumber: number
  retryCount: number
  maxRetries: number
  createdAt: string
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

export interface RunArtifactBundle {
  artifact: RunArtifactRow | null
  children: Array<{ run: RunRow; artifact: RunArtifactRow | null }>
}

export interface StepRow {
  id: string
  runId: string
  name: string
  status: string
  duration: number
  action: unknown | null
  observation: string | null
  reasoning: string | null
  plannedAction: unknown | null
  result: string | null
  error: string | null
  screenshotPath: string | null
  screenshotBeforePath: string | null
  healingAttempts: unknown[] | null
  retryCount: number
  capturedVariables: Record<string, string> | null
  stepOrder: number
  annotationData: unknown | null
  healingScreenshotPaths: string[] | null
  accessibilityViolations: unknown[] | null
  confidence: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  subActionsData: unknown[] | null
  consoleLogs: unknown[] | null
  networkLogs: unknown[] | null
  variableSnapshot: Record<string, { value: string; source: string }> | null
  originalStepName: string | null
  screenContextBefore: string | null
  screenContextAfter: string | null
  createdAt: string
}

interface ReasoningTraceRow {
  id: string
  stepId: string
  observeText: string | null
  observeDuration: number | null
  planReasoning: string | null
  planConfidence: number | null
  planAction: unknown | null
  planDuration: number | null
  executeAction: unknown | null
  executeDuration: number | null
  verifyReasoning: string | null
  verifySuccess: boolean | null
  verifyDuration: number | null
  healAttempts: unknown[] | null
  totalDuration: number | null
  screenStateBefore: string | null
  screenStateAfter: string | null
  createdAt: string
}

interface ExecutionLogRow {
  id: string
  runId: string
  stepId: string | null
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
  status?: string
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
  passRate: number
  flakeRate: number
  avgDuration: number
  passed: number
  failed: number
  filePath?: string
  suiteId?: string
}

export interface DeleteRunResult {
  deleted: boolean
  deletedRunIds: string[]
  screenshotPaths: string[]
  videoPaths: string[]
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

export function runSqliteMigrations(
  db: BetterSqlite3Database,
  migrations: readonly DashboardMigration[],
  schemaVersion: number,
): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  if (currentVersion > schemaVersion) {
    throw new Error(
      `SQLite database user_version ${currentVersion} is not compatible with schema version ${schemaVersion}. `
      + 'Remove the dashboard database or use a compatible agent-qa version.',
    )
  }
  if (currentVersion === schemaVersion) return

  const runnableMigrations = migrations.filter(migration => migration.version <= schemaVersion)
  if (runnableMigrations.length !== schemaVersion) {
    throw new Error(`Expected ${schemaVersion} SQLite migration(s), found ${runnableMigrations.length}`)
  }
  runnableMigrations.forEach((migration, index) => {
    const expectedVersion = index + 1
    if (migration.version !== expectedVersion) {
      throw new Error(`SQLite migrations must be contiguous and sorted: expected version ${expectedVersion}, got ${migration.version}`)
    }
  })

  db.pragma('foreign_keys = OFF')
  try {
    for (const migration of runnableMigrations) {
      if (migration.version > currentVersion) {
        const runAll = db.transaction(() => {
          for (const sql of migration.sql) {
            db.exec(sql)
          }
          db.pragma(`user_version = ${migration.version}`)
        })
        runAll()
      }
    }
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

export class DashboardDatabase {
  private db: BetterSqlite3Database

  constructor({ dbPath = DASHBOARD_DB_PATH_FALLBACK }: { dbPath?: string } = {}) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = createBetterSqlite3Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.runMigrations()
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
    videoPath?: string
    failureSummary?: string
    platform?: string
    testFileContent?: string
    modelName?: string
    llmProvider?: string
    parentRunId?: string
    attemptNumber?: number
    retryCount?: number
    maxRetries?: number
    testId?: string
    suiteId?: string
  }): string {
    const id = run.id || generateRunId()
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, name, file_path, status, duration, attributes, environment, metadata, started_at, ended_at, video_path, failure_summary, platform, test_file_content, model_name, llm_provider, parent_run_id, attempt_number, retry_count, max_retries, test_id, suite_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      run.videoPath ?? null,
      run.failureSummary ?? null,
      run.platform ?? 'web',
      run.testFileContent ?? null,
      run.modelName ?? null,
      run.llmProvider ?? null,
      run.parentRunId ?? null,
      run.attemptNumber ?? 0,
      run.retryCount ?? 0,
      run.maxRetries ?? 0,
      run.testId ?? null,
      run.suiteId ?? null,
    )
    return id
  }

  updateRun(id: string, updates: {
    name?: string
    status?: string
    duration?: number
    startedAt?: string
    endedAt?: string
    failureSummary?: string
    errorLog?: string
    memoryLog?: string
    videoPath?: string
    attributes?: RunAttributes
    platform?: string
    testId?: string
    suiteId?: string
  }): void {
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status) }
    if (updates.duration !== undefined) { fields.push('duration = ?'); values.push(updates.duration) }
    if (updates.startedAt !== undefined) { fields.push('started_at = ?'); values.push(updates.startedAt) }
    if (updates.endedAt !== undefined) { fields.push('ended_at = ?'); values.push(updates.endedAt) }
    if (updates.failureSummary !== undefined) { fields.push('failure_summary = ?'); values.push(updates.failureSummary) }
    if (updates.errorLog !== undefined) { fields.push('error_log = ?'); values.push(updates.errorLog) }
    if (updates.memoryLog !== undefined) { fields.push('memory_log = ?'); values.push(updates.memoryLog) }
    if (updates.videoPath !== undefined) { fields.push('video_path = ?'); values.push(updates.videoPath) }
    if (updates.attributes !== undefined) { fields.push('attributes = ?'); values.push(JSON.stringify(updates.attributes)) }
    if (updates.platform !== undefined) { fields.push('platform = ?'); values.push(updates.platform) }
    if (updates.testId !== undefined) { fields.push('test_id = ?'); values.push(updates.testId) }
    if (updates.suiteId !== undefined) { fields.push('suite_id = ?'); values.push(updates.suiteId) }
    if (fields.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values)
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
    maxRetries?: number
  }): string {
    const id = run.id || generateRunId()
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, name, file_path, status, priority, duration, attributes, started_at, ended_at, platform, test_file_content, model_name, llm_provider, metadata, parallel, max_retries)
      VALUES (?, ?, ?, 'pending', ?, 0, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
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
      run.maxRetries ?? 0,
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

  updateRunStatus(id: string, status: string): void {
    this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id)
  }

  insertStep(step: {
    id?: string
    runId: string
    name: string
    status: string
    duration: number
    action?: unknown
    observation?: string
    reasoning?: string
    plannedAction?: unknown
    result?: string
    error?: string
    screenshotPath?: string
    screenshotBeforePath?: string
    healingAttempts?: unknown[]
    retryCount?: number
    capturedVariables?: Record<string, string>
    stepOrder: number
    annotationData?: unknown
    healingScreenshotPaths?: string[]
    accessibilityViolations?: unknown[]
    confidence?: number
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    subActionsData?: unknown[]
    consoleLogs?: unknown[]
    networkLogs?: unknown[]
    variableSnapshot?: Record<string, unknown>
    originalStepName?: string
    screenContextBefore?: string
    screenContextAfter?: string
  }): string {
    const id = step.id || randomUUID()
    const stmt = this.db.prepare(`
      INSERT INTO steps (id, run_id, name, status, duration, action, observation, reasoning, planned_action, result, error, screenshot_path, screenshot_before_path, healing_attempts, retry_count, captured_variables, step_order, annotation_data, healing_screenshot_paths, accessibility_violations, confidence, prompt_tokens, completion_tokens, total_tokens, sub_actions_data, console_logs, network_logs, variable_snapshot, original_step_name, screen_context_before, screen_context_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      step.runId,
      step.name,
      step.status,
      step.duration,
      step.action ? JSON.stringify(step.action) : null,
      step.observation ?? null,
      step.reasoning ?? null,
      step.plannedAction ? JSON.stringify(step.plannedAction) : null,
      step.result ?? null,
      step.error ?? null,
      step.screenshotPath ?? null,
      step.screenshotBeforePath ?? null,
      step.healingAttempts ? JSON.stringify(step.healingAttempts) : null,
      step.retryCount ?? 0,
      step.capturedVariables ? JSON.stringify(step.capturedVariables) : null,
      step.stepOrder,
      step.annotationData ? JSON.stringify(step.annotationData) : null,
      step.healingScreenshotPaths ? JSON.stringify(step.healingScreenshotPaths) : null,
      step.accessibilityViolations ? JSON.stringify(step.accessibilityViolations) : null,
      step.confidence ?? null,
      step.promptTokens ?? 0,
      step.completionTokens ?? 0,
      step.totalTokens ?? 0,
      step.subActionsData ? JSON.stringify(step.subActionsData) : null,
      step.consoleLogs ? JSON.stringify(step.consoleLogs) : null,
      step.networkLogs ? JSON.stringify(step.networkLogs) : null,
      step.variableSnapshot ? JSON.stringify(step.variableSnapshot) : null,
      step.originalStepName ?? null,
      step.screenContextBefore ?? null,
      step.screenContextAfter ?? null,
    )
    return id
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
    if (!hasRegex) return runs

    const start = input.offset ?? 0
    const end = input.limit !== undefined ? start + input.limit : undefined
    return runs.slice(start, end)
  }

  private buildTrendsFromRuns(runs: RunRow[]): {
    daily: { date: string; passed: number; failed: number; total: number; avgDuration: number }[]
    passRate: number
    totalRuns: number
    avgDuration: number
  } {
    const totalRuns = runs.length
    const passedTotal = runs.filter((run) => this.isSuccessfulRunStatus(run.status)).length
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
            passed: dayRuns.filter((run) => this.isSuccessfulRunStatus(run.status)).length,
            failed: dayRuns.filter((run) => run.status === 'failed').length,
            total,
            avgDuration: total > 0 ? dayRuns.reduce((sum, run) => sum + run.duration, 0) / total : 0,
          }
        }),
      passRate: totalRuns > 0 ? passedTotal / totalRuns : 0,
      totalRuns,
      avgDuration,
    }
  }

  getRuns(opts: RunsFilter = {}): RunRow[] {
    const conditions: string[] = ['parent_run_id IS NULL']
    const params: unknown[] = []

    if (opts.status) {
      conditions.push('status = ?')
      params.push(opts.status)
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

    return this.queryRunsWithAttributePredicates({
      conditions,
      params,
      attributePredicates: opts.attributePredicates,
      orderBy: 'ORDER BY created_at DESC',
      limit: opts.limit,
      offset: opts.offset,
    })
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapRunRow(row) : undefined
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

  deleteRun(id: string): DeleteRunResult {
    const runRows = this.db.prepare(`
      WITH RECURSIVE run_tree(id) AS (
        SELECT id FROM runs WHERE id = ?
        UNION ALL
        SELECT runs.id
        FROM runs
        INNER JOIN run_tree ON runs.parent_run_id = run_tree.id
      )
      SELECT *
      FROM runs
      WHERE id IN (SELECT id FROM run_tree)
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC
    `).all(id, id) as Record<string, unknown>[]

    if (runRows.length === 0) {
      return {
        deleted: false,
        deletedRunIds: [],
        screenshotPaths: [],
        videoPaths: [],
      }
    }

    const deletedRunIds = runRows.map((row) => row.id as string)
    const runPlaceholders = deletedRunIds.map(() => '?').join(', ')
    const stepRows = this.db.prepare(`
      SELECT id, screenshot_path, screenshot_before_path, healing_screenshot_paths
      FROM steps
      WHERE run_id IN (${runPlaceholders})
    `).all(...deletedRunIds) as Array<{
      id: string
      screenshot_path: string | null
      screenshot_before_path: string | null
      healing_screenshot_paths: string | null
    }>
    const deletedStepIds = stepRows.map((row) => row.id)
    const screenshotPaths = stepRows.flatMap((row) => {
      const healingPaths = (() => {
        if (!row.healing_screenshot_paths) return []
        try {
          const parsed = JSON.parse(row.healing_screenshot_paths) as unknown
          return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
            : []
        } catch {
          return []
        }
      })()

      return [
        row.screenshot_path,
        row.screenshot_before_path,
        ...healingPaths,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    })
    const videoPaths = runRows
      .map((row) => row.video_path)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)

    const deleteAll = this.db.transaction(() => {
      if (deletedStepIds.length > 0) {
        const stepPlaceholders = deletedStepIds.map(() => '?').join(', ')
        this.db.prepare(`
          DELETE FROM reasoning_traces
          WHERE step_id IN (${stepPlaceholders})
        `).run(...deletedStepIds)
      }

      this.db.prepare(`
        DELETE FROM steps
        WHERE run_id IN (${runPlaceholders})
      `).run(...deletedRunIds)

      this.db.prepare(`
        DELETE FROM runs
        WHERE id IN (${runPlaceholders})
      `).run(...deletedRunIds)
    })

    deleteAll()

    return {
      deleted: true,
      deletedRunIds,
      screenshotPaths,
      videoPaths,
    }
  }

  getSteps(runId: string): StepRow[] {
    const rows = this.db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY step_order').all(runId) as Record<string, unknown>[]
    return rows.map(r => this.mapStepRow(r))
  }

  getCapturedVariableNames(testId: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT captured_variables FROM steps
      WHERE run_id IN (SELECT id FROM runs WHERE test_id = ?)
      AND captured_variables IS NOT NULL
      LIMIT 100
    `).all(testId) as Array<{ captured_variables: string }>

    const nameSet = new Set<string>()
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.captured_variables) as Record<string, string>
        for (const key of Object.keys(parsed)) nameSet.add(key)
      } catch { /* skip malformed */ }
    }
    return [...nameSet].sort()
  }

  getRunsByParent(parentRunId: string): RunRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at ASC'
    ).all(parentRunId) as Record<string, unknown>[]
    return rows.map(r => this.mapRunRow(r))
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
    const children = this.getRunsByParent(runId).map((run) => ({
      run,
      artifact: this.getRunArtifact(run.id),
    }))
    return {
      artifact: this.getRunArtifact(runId),
      children,
    }
  }

  updateRunRetryInfo(id: string, info: { retryCount: number; maxRetries: number }): void {
    this.db.prepare('UPDATE runs SET retry_count = ?, max_retries = ? WHERE id = ?')
      .run(info.retryCount, info.maxRetries, id)
  }

  private isSuccessfulRunStatus(status: string): boolean {
    return status === 'passed' || status === 'flaky'
  }

  private getHealedRunIds(runIds: string[]): Set<string> {
    if (runIds.length === 0) return new Set()

    const placeholders = runIds.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT DISTINCT run_id
      FROM steps
      WHERE status = 'healed'
        AND run_id IN (${placeholders})
    `).all(...runIds) as Array<{ run_id: string }>

    return new Set(rows.map((row) => row.run_id))
  }

  private summarizeAnalyticsRuns(
    runs: Array<Pick<RunRow, 'id' | 'status' | 'duration'>>,
    healedRunIds: Set<string>,
  ) {
    const totalRuns = runs.length
    const passed = runs.filter((run) => this.isSuccessfulRunStatus(run.status)).length
    const failed = runs.filter((run) => run.status === 'failed').length
    const flaky = runs.filter((run) => run.status === 'flaky' || healedRunIds.has(run.id)).length
    const totalDuration = runs.reduce((sum, run) => sum + run.duration, 0)

    return {
      totalRuns,
      passed,
      failed,
      flaky,
      passRate: totalRuns > 0 ? passed / totalRuns : 0,
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

    if (dimension === 'suite') {
      conditions.push('parent_run_id IS NULL')
      conditions.push('suite_id IS NOT NULL')
    } else if (dimension === 'platform') {
      conditions.push('parent_run_id IS NULL')
    } else {
      conditions.push('NOT (suite_id IS NOT NULL AND parent_run_id IS NULL)')
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
    memory: {
      runs: number
      added: number
      confirmed: number
      deprecated: number
      deleted: number
      curatorTokens: number
    }
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
          healed: dayHealedRunIds.size,
          duration: daySummary.avgDuration,
        }
      })

    const runIds = runs.map((run) => run.id)
    const totalTokens = runIds.length > 0
      ? ((this.db.prepare(`
          SELECT COALESCE(SUM(total_tokens), 0) as total_tokens
          FROM steps
          WHERE run_id IN (${runIds.map(() => '?').join(',')})
        `).get(...runIds) as Record<string, unknown>).total_tokens as number) || 0
      : 0

    const memorySummary = {
      runs: 0,
      added: 0,
      confirmed: 0,
      deprecated: 0,
      deleted: 0,
      curatorTokens: 0,
    }
    for (const run of runs) {
      if (!run.memoryLog) continue
      memorySummary.runs++
      try {
        const parsed = JSON.parse(run.memoryLog) as Record<string, unknown>
        memorySummary.added += Number(parsed.added ?? 0) || 0
        memorySummary.confirmed += Number(parsed.confirmed ?? 0) || 0
        memorySummary.deprecated += Number(parsed.deprecated ?? 0) || 0
        memorySummary.deleted += Number(parsed.deleted ?? 0) || 0
        const tokenUsage = parsed.tokenUsage && typeof parsed.tokenUsage === 'object'
          ? parsed.tokenUsage as Record<string, unknown>
          : {}
        memorySummary.curatorTokens += Number(tokenUsage.totalTokens ?? 0) || 0
      } catch {
        // Ignore malformed historical memory logs in aggregate insights.
      }
    }

    return {
      totalRuns: summary.totalRuns,
      passed: summary.passed,
      failed: summary.failed,
      flaky: summary.flaky,
      flakeRate: summary.flakeRate,
      avgDuration: summary.avgDuration,
      totalTokens,
      runs: daily,
      memory: memorySummary,
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
      LEFT JOIN steps s ON s.run_id = r.id
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
  } {
    const conditions: string[] = []
    const params: unknown[] = []
    if (opts.from) { conditions.push('created_at >= ?'); params.push(opts.from) }
    if (opts.to) { conditions.push('created_at <= ?'); params.push(opts.to) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const byModel = this.db.prepare(`
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

    return {
      byModel,
      bySource,
      totals: { promptTokens: totalsRow.promptTokens, completionTokens: totalsRow.completionTokens },
    }
  }

  getRunsByTestName(name: string, opts?: { limit?: number; offset?: number; attributePredicates?: AttributePredicate[] }): RunRow[] {
    return this.queryRunsWithAttributePredicates({
      conditions: ['name = ?', 'parent_run_id IS NULL'],
      params: [name],
      attributePredicates: opts?.attributePredicates,
      orderBy: 'ORDER BY started_at DESC',
      limit: opts?.limit,
      offset: opts?.offset,
    })
  }

  getRunsByTestNameCount(name: string, opts?: { attributePredicates?: AttributePredicate[] }): number {
    if (opts?.attributePredicates?.length) {
      return this.getRunsByTestName(name, { attributePredicates: opts.attributePredicates }).length
    }
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM runs WHERE name = ? AND parent_run_id IS NULL').get(name) as { cnt: number }
    return row.cnt
  }

  getTestTrends(name: string, opts?: { from?: string; attributePredicates?: AttributePredicate[] }): {
    daily: { date: string; passed: number; failed: number; total: number; avgDuration: number }[]
    passRate: number
    totalRuns: number
    avgDuration: number
  } {
    const conditions = ['name = ?', 'parent_run_id IS NULL']
    const params: unknown[] = [name]
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

  getRunsBySuiteId(suiteId: string, opts?: { limit?: number; offset?: number; attributePredicates?: AttributePredicate[] }): RunRow[] {
    return this.queryRunsWithAttributePredicates({
      conditions: ['suite_id = ?', 'parent_run_id IS NULL'],
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
      WHERE suite_id = ?
        AND parent_run_id IS NULL
    `).get(suiteId) as { cnt: number }
    return row.cnt
  }

  getSuiteTrends(suiteId: string, opts?: { from?: string; attributePredicates?: AttributePredicate[] }): {
    daily: { date: string; passed: number; failed: number; total: number; avgDuration: number }[]
    passRate: number
    totalRuns: number
    avgDuration: number
  } {
    const conditions = ['suite_id = ?', 'parent_run_id IS NULL']
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
      left.passRate - right.passRate ||
      left.label.localeCompare(right.label),
    )

    const limit = opts.limit ?? 25
    return rows.slice(0, limit)
  }

  getFlakyTests(opts?: { minRuns?: number; limit?: number }): {
    name: string; filePath: string | null; totalRuns: number; passRate: number; flakyScore: number
  }[] {
    const minRuns = opts?.minRuns ?? 3
    const limit = opts?.limit ?? 50

    const tests = this.db.prepare(`
      SELECT name,
             MAX(file_path) as file_path,
             COUNT(*) as total_runs,
             SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
             GROUP_CONCAT(status, ',') as status_seq
      FROM (
        SELECT name, status, file_path FROM runs
        WHERE status IN ('passed', 'failed')
        ORDER BY name, started_at DESC
      )
      GROUP BY name
      HAVING COUNT(*) >= ?
      LIMIT ?
    `).all(minRuns, limit) as Record<string, unknown>[]

    return tests.map(t => {
      const statusSeq = (t.status_seq as string).split(',')
      let alternations = 0
      for (let i = 1; i < statusSeq.length; i++) {
        if (statusSeq[i] !== statusSeq[i - 1]) alternations++
      }
      const flakyScore = statusSeq.length > 1 ? alternations / (statusSeq.length - 1) : 0
      const totalRuns = t.total_runs as number
      const passed = t.passed as number

      return {
        name: t.name as string,
        filePath: (t.file_path as string) ?? null,
        totalRuns,
        passRate: passed / totalRuns,
        flakyScore,
      }
    }).sort((a, b) => b.flakyScore - a.flakyScore)
  }

  getAccessibilitySummary(runId: string) {
    const steps = this.getSteps(runId)
    const allViolations: any[] = []
    let stepsWithViolations = 0

    for (const step of steps) {
      if (step.accessibilityViolations && (step.accessibilityViolations as any[]).length > 0) {
        stepsWithViolations++
        allViolations.push(...(step.accessibilityViolations as any[]))
      }
    }

    const bySeverity: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 }
    const byRule: Record<string, { count: number; impact: string }> = {}

    for (const v of allViolations) {
      bySeverity[v.impact] = (bySeverity[v.impact] || 0) + 1
      if (!byRule[v.ruleId]) byRule[v.ruleId] = { count: 0, impact: v.impact }
      byRule[v.ruleId].count++
    }

    return {
      total: allViolations.length,
      bySeverity,
      byRule: Object.entries(byRule)
        .map(([ruleId, data]) => ({ ruleId, ...data }))
        .sort((a, b) => b.count - a.count),
      stepsWithViolations,
      totalSteps: steps.length,
    }
  }

  getStep(stepId: string): StepRow | undefined {
    const row = this.db.prepare('SELECT * FROM steps WHERE id = ?').get(stepId) as Record<string, unknown> | undefined
    return row ? this.mapStepRow(row) : undefined
  }

  insertReasoningTrace(trace: {
    stepId: string
    observeText?: string
    observeDuration?: number
    planReasoning?: string
    planConfidence?: number
    planAction?: unknown
    planDuration?: number
    executeAction?: unknown
    executeDuration?: number
    verifyReasoning?: string
    verifySuccess?: boolean
    verifyDuration?: number
    healAttempts?: unknown[]
    totalDuration?: number
    screenStateBefore?: string
    screenStateAfter?: string
  }): string {
    const id = randomUUID()
    const stmt = this.db.prepare(`
      INSERT INTO reasoning_traces (id, step_id, observe_text, observe_duration, plan_reasoning, plan_confidence, plan_action, plan_duration, execute_action, execute_duration, verify_reasoning, verify_success, verify_duration, heal_attempts, total_duration, screen_state_before, screen_state_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      trace.stepId,
      trace.observeText ?? null,
      trace.observeDuration ?? null,
      trace.planReasoning ?? null,
      trace.planConfidence ?? null,
      trace.planAction ? JSON.stringify(trace.planAction) : null,
      trace.planDuration ?? null,
      trace.executeAction ? JSON.stringify(trace.executeAction) : null,
      trace.executeDuration ?? null,
      trace.verifyReasoning ?? null,
      trace.verifySuccess !== undefined ? (trace.verifySuccess ? 1 : 0) : null,
      trace.verifyDuration ?? null,
      trace.healAttempts ? JSON.stringify(trace.healAttempts) : null,
      trace.totalDuration ?? null,
      trace.screenStateBefore ?? null,
      trace.screenStateAfter ?? null,
    )
    return id
  }

  getReasoningTrace(runId: string, stepOrder: number): ReasoningTraceRow | undefined {
    const row = this.db.prepare(`
      SELECT rt.* FROM reasoning_traces rt
      INNER JOIN steps s ON s.id = rt.step_id
      WHERE s.run_id = ? AND s.step_order = ?
    `).get(runId, stepOrder) as Record<string, unknown> | undefined
    return row ? this.mapReasoningTraceRow(row) : undefined
  }

  // Satisfies LogStorage interface from @vostride/agent-qa-core (structural typing)
  insertLogs(entries: LogEntry[]): void {
    if (entries.length === 0) return
    const stmt = this.db.prepare(
      'INSERT INTO logs (id, step_id, run_id, level, source, message, data, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const insertAll = this.db.transaction(() => {
      for (const entry of entries) {
        stmt.run(
          entry.id,
          entry.stepId,
          entry.runId,
          entry.level,
          entry.source,
          entry.message,
          JSON.stringify(entry.data),
          entry.timestamp,
        )
      }
    })
    try {
      insertAll()
    } catch {
      // FK violations (e.g. run_id not yet in runs table) are non-fatal for logs
    }
  }

  getLogs(opts: {
    runId?: string
    stepId?: string
    level?: string
    source?: string
    limit?: number
    offset?: number
  } = {}): LogEntry[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (opts.runId) {
      conditions.push('run_id = ?')
      params.push(opts.runId)
    }
    if (opts.stepId) {
      conditions.push('step_id = ?')
      params.push(opts.stepId)
    }
    if (opts.level) {
      conditions.push('level = ?')
      params.push(opts.level)
    }
    if (opts.source) {
      conditions.push('source = ?')
      params.push(opts.source)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = opts.limit ?? 1000
    const offset = opts.offset ?? 0
    params.push(limit, offset)

    const rows = this.db.prepare(
      `SELECT * FROM logs ${where} ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
    ).all(...params) as Record<string, unknown>[]

    return rows.map(r => this.mapLogRow(r))
  }

  insertExecutionLog(data: InsertExecutionLogInput): void {
    const stmt = this.db.prepare(`
      INSERT INTO execution_logs (id, run_id, step_id, type, name, hook_id, phase, status, duration, stdout, stderr, return_data, variables)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      videoPath: (r.video_path as string) ?? null,
      failureSummary: (r.failure_summary as string) ?? null,
      errorLog: (r.error_log as string) ?? null,
      memoryLog: (r.memory_log as string) ?? null,
      testId: (r.test_id as string) ?? null,
      suiteId: (r.suite_id as string) ?? null,
      platform: (r.platform as string) ?? 'web',
      testFileContent: (r.test_file_content as string) ?? null,
      modelName: (r.model_name as string) ?? null,
      llmProvider: (r.llm_provider as string) ?? null,
      parallel: Boolean(r.parallel),
      parentRunId: (r.parent_run_id as string) ?? null,
      attemptNumber: (r.attempt_number as number) ?? 0,
      retryCount: (r.retry_count as number) ?? 0,
      maxRetries: (r.max_retries as number) ?? 0,
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

  private mapStepRow(r: Record<string, unknown>): StepRow {
    return {
      id: r.id as string,
      runId: r.run_id as string,
      name: r.name as string,
      status: r.status as string,
      duration: r.duration as number,
      action: r.action ? JSON.parse(r.action as string) : null,
      observation: r.observation as string | null,
      reasoning: r.reasoning as string | null,
      plannedAction: r.planned_action ? JSON.parse(r.planned_action as string) : null,
      result: r.result as string | null,
      error: r.error as string | null,
      screenshotPath: r.screenshot_path as string | null,
      screenshotBeforePath: (r.screenshot_before_path as string) ?? null,
      healingAttempts: r.healing_attempts ? JSON.parse(r.healing_attempts as string) : null,
      retryCount: r.retry_count as number,
      capturedVariables: r.captured_variables ? JSON.parse(r.captured_variables as string) : null,
      stepOrder: r.step_order as number,
      annotationData: r.annotation_data ? JSON.parse(r.annotation_data as string) : null,
      healingScreenshotPaths: r.healing_screenshot_paths ? JSON.parse(r.healing_screenshot_paths as string) : null,
      accessibilityViolations: r.accessibility_violations ? JSON.parse(r.accessibility_violations as string) : null,
      confidence: (r.confidence as number) ?? null,
      promptTokens: (r.prompt_tokens as number) ?? 0,
      completionTokens: (r.completion_tokens as number) ?? 0,
      totalTokens: (r.total_tokens as number) ?? 0,
      subActionsData: r.sub_actions_data ? JSON.parse(r.sub_actions_data as string) : null,
      consoleLogs: r.console_logs ? JSON.parse(r.console_logs as string) : null,
      networkLogs: r.network_logs ? JSON.parse(r.network_logs as string) : null,
      variableSnapshot: r.variable_snapshot ? JSON.parse(r.variable_snapshot as string) : null,
      originalStepName: (r.original_step_name as string) ?? null,
      screenContextBefore: (r.screen_context_before as string) ?? null,
      screenContextAfter: (r.screen_context_after as string) ?? null,
      createdAt: r.created_at as string,
    }
  }

  private mapLogRow(r: Record<string, unknown>): LogEntry {
    let data: Record<string, unknown> = {}
    if (r.data) {
      try { data = JSON.parse(r.data as string) } catch { /* invalid JSON → empty */ }
    }
    return {
      id: r.id as string,
      stepId: (r.step_id as string) ?? null,
      runId: r.run_id as string,
      level: r.level as LogEntry['level'],
      source: r.source as LogEntry['source'],
      message: r.message as string,
      data,
      timestamp: r.timestamp as string,
    }
  }

  private mapReasoningTraceRow(r: Record<string, unknown>): ReasoningTraceRow {
    return {
      id: r.id as string,
      stepId: r.step_id as string,
      observeText: r.observe_text as string | null,
      observeDuration: r.observe_duration as number | null,
      planReasoning: r.plan_reasoning as string | null,
      planConfidence: r.plan_confidence as number | null,
      planAction: r.plan_action ? JSON.parse(r.plan_action as string) : null,
      planDuration: r.plan_duration as number | null,
      executeAction: r.execute_action ? JSON.parse(r.execute_action as string) : null,
      executeDuration: r.execute_duration as number | null,
      verifyReasoning: r.verify_reasoning as string | null,
      verifySuccess: r.verify_success !== null ? Boolean(r.verify_success) : null,
      verifyDuration: r.verify_duration as number | null,
      healAttempts: r.heal_attempts ? JSON.parse(r.heal_attempts as string) : null,
      totalDuration: r.total_duration as number | null,
      screenStateBefore: r.screen_state_before as string | null,
      screenStateAfter: r.screen_state_after as string | null,
      createdAt: r.created_at as string,
    }
  }
}
