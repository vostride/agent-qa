import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DashboardDatabase, runSqliteMigrations } from '../db/database.js'
import { createDashboardSqliteDatabase, type DashboardSqliteDatabase } from '../db/sqlite.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../db/schema.js'
import { createDashboardRunIngest } from '../reporter/dashboard-subscriber.js'
import { createDashboardRunDetailReader } from '../run-service/run-detail-reader.js'
import { createFunctionRegistry, invokeFunction, RUNS_DETAIL_FUNCTION_ID, type FunctionDeps } from '@vostride/agent-qa-agent'
import { asRunId, EvidenceArtifactRefSchema, RunDetailProjectionSchema } from '@vostride/agent-qa-schema'
import type { RunEventEnvelope, StepFinalizedPayload, SubActionRecordedPayload } from '@vostride/agent-qa-schema'
import type { ModelProfile } from '@vostride/agent-qa-schema'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { createModel, createTokenAccounting } from '@vostride/agent-qa-model'
import {
  createMemberEventSink, createRunEventBus, createStepModelScope,
  LLMPlanner, LLMVerifier, makeScreenState, runMemberTest, SecretRedactor, SecretStore,
} from '@vostride/agent-qa-runner'
import type { StepModelScope } from '@vostride/agent-qa-runner'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'

// Frozen pre-423 v2 DDL, copied before the v3 change. Never derived from current MIGRATIONS.
const V2_SQL: string[] = [
  "CREATE TABLE IF NOT EXISTS runs (\n        id TEXT PRIMARY KEY,\n        name TEXT NOT NULL,\n        file_path TEXT,\n        status TEXT NOT NULL CHECK(status IN ('passed','failed','skipped','running','cancelled','pending','flaky')),\n        priority INTEGER NOT NULL DEFAULT 0,\n        duration INTEGER NOT NULL DEFAULT 0,\n        attributes TEXT NOT NULL DEFAULT '{}',\n        environment TEXT,\n        metadata TEXT,\n        started_at TEXT,\n        ended_at TEXT,\n        created_at TEXT DEFAULT CURRENT_TIMESTAMP,\n        failure_summary TEXT,\n        platform TEXT DEFAULT 'web',\n        test_file_content TEXT,\n        model_name TEXT,\n        llm_provider TEXT,\n        parallel INTEGER DEFAULT 0,\n        error_log TEXT,\n        memory_log TEXT,\n        test_id TEXT,\n        suite_id TEXT\n      )",
  "CREATE TABLE IF NOT EXISTS execution_logs (\n        id TEXT PRIMARY KEY,\n        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n        step_id TEXT,\n        type TEXT NOT NULL CHECK(type IN ('hook', 'appium-script', 'runjs')),\n        name TEXT NOT NULL,\n        phase TEXT NOT NULL CHECK(phase IN ('setup', 'teardown', 'inline')),\n        status TEXT NOT NULL CHECK(status IN ('passed', 'failed')),\n        duration INTEGER NOT NULL DEFAULT 0,\n        stdout TEXT,\n        stderr TEXT,\n        return_data TEXT,\n        variables TEXT,\n        created_at TEXT DEFAULT CURRENT_TIMESTAMP,\n        hook_id TEXT,\n        test_index INTEGER,\n        step_index INTEGER\n      )",
  "CREATE TABLE IF NOT EXISTS token_events (\n        id TEXT PRIMARY KEY,\n        model_name TEXT NOT NULL,\n        prompt_tokens INTEGER NOT NULL DEFAULT 0,\n        completion_tokens INTEGER NOT NULL DEFAULT 0,\n        source TEXT NOT NULL CHECK(source IN ('test-run', 'live-editor')),\n        created_at TEXT DEFAULT CURRENT_TIMESTAMP\n      )",
  "CREATE TABLE IF NOT EXISTS run_artifacts (\n        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,\n        kind TEXT NOT NULL CHECK(kind IN ('test', 'unknown')),\n        schema_version INTEGER NOT NULL,\n        payload TEXT NOT NULL DEFAULT '{}',\n        finalized_at TEXT,\n        created_at TEXT DEFAULT CURRENT_TIMESTAMP,\n        updated_at TEXT DEFAULT CURRENT_TIMESTAMP\n      )",
  "CREATE TABLE IF NOT EXISTS run_members (\n        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n        test_index INTEGER NOT NULL,\n        test_id TEXT,\n        name TEXT,\n        file_path TEXT,\n        suite_id TEXT,\n        suite_name TEXT,\n        suite_index INTEGER,\n        total_steps INTEGER,\n        outcome TEXT,\n        duration_ms INTEGER,\n        failure_summary TEXT,\n        retry_count INTEGER,\n        attempts INTEGER NOT NULL DEFAULT 1,\n        PRIMARY KEY (run_id, test_index)\n      )",
  "CREATE TABLE IF NOT EXISTS run_steps (\n        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n        test_index INTEGER NOT NULL,\n        step_index INTEGER NOT NULL,\n        step_text TEXT,\n        cache_status TEXT NOT NULL,\n        verifier_verdict TEXT NOT NULL,\n        self_heal_occurred INTEGER NOT NULL,\n        brief_digest TEXT NOT NULL,\n        status TEXT,\n        duration_ms INTEGER,\n        error TEXT,\n        prompt_tokens INTEGER,\n        completion_tokens INTEGER,\n        total_tokens INTEGER,\n        PRIMARY KEY (run_id, test_index, step_index)\n      )",
  "CREATE TABLE IF NOT EXISTS run_sub_actions (\n        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n        test_index INTEGER NOT NULL,\n        step_index INTEGER NOT NULL,\n        sub_action_index INTEGER NOT NULL,\n        plan TEXT NOT NULL,\n        planned_action TEXT NOT NULL,\n        grounding TEXT,\n        result TEXT NOT NULL,\n        screen_state_hash TEXT NOT NULL,\n        screen_state_hash_after TEXT,\n        artifact_refs TEXT,\n        PRIMARY KEY (run_id, test_index, step_index, sub_action_index)\n      )",
  "CREATE INDEX IF NOT EXISTS idx_run_members_run ON run_members(run_id)",
  "CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, test_index)",
  "CREATE INDEX IF NOT EXISTS idx_run_sub_actions_run ON run_sub_actions(run_id, test_index, step_index)",
  "CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)",
  "CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at)",
  "CREATE INDEX IF NOT EXISTS idx_runs_name ON runs(name)",
  "CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(status, priority, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_execution_logs_run_id ON execution_logs(run_id)",
  "CREATE INDEX IF NOT EXISTS idx_execution_logs_step_id ON execution_logs(step_id)",
  "CREATE INDEX IF NOT EXISTS idx_execution_logs_type ON execution_logs(type)",
  "CREATE INDEX IF NOT EXISTS idx_token_events_model ON token_events(model_name)",
  "CREATE INDEX IF NOT EXISTS idx_token_events_source ON token_events(source)",
  "CREATE INDEX IF NOT EXISTS idx_token_events_created ON token_events(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_run_artifacts_kind ON run_artifacts(kind)",
  "CREATE INDEX IF NOT EXISTS idx_run_artifacts_finalized ON run_artifacts(finalized_at)"
]

let dir: string
const opened: DashboardSqliteDatabase[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-qa-423-migration-')) })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const db of opened.splice(0)) db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Only the provider transport and platform are doubles. The model owner, SDK, scoped
// consumers, member loop, late extractor, event sink, subscriber and SQLite are real.
async function usageRun(options: { retry?: boolean; omitCache?: boolean; unscoped?: boolean } = {}) {
  const runId = asRunId(generateRunId())
  const testId = generateTestId()
  const dbPath = join(dir, `${runId}.db`)
  const db = new DashboardDatabase({ dbPath })
  // The routed model id is declared, so it never reaches final egress.
  const redactor = new SecretRedactor(new SecretStore({ ROUTED_MODEL: 'synthetic-routed-model' }))
  const mask = (text: string) => redactor.redactString(text)
  const store = new FsEvidenceArtifactStore({ root: dir, runId })
  const bus = createRunEventBus({ runId })
  const events: RunEventEnvelope[] = []
  const ingest = createDashboardRunIngest({ db, runId })
  bus.subscribe(1, event => { events.push(event); ingest.handler(event) })
  let planningCalls = 0
  let verifierCalls = 0
  let retry = options.retry
  let extractionStarted = false
  let terminalCountAtExtraction = -1
  const requests: string[] = []
  const transport = vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body))
    if (retry) {
      retry = false
      requests.push('failed-attempt')
      return new Response(JSON.stringify({ error: { message: 'Synthetic transient failure' } }),
        { status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' } })
    }
    const planning = Array.isArray(request.tools) && request.tools.some(
      (tool: { function: { name: string } }) => tool.function.name === 'web_click',
    )
    const extracting = request.response_format?.json_schema?.name === 'extraction_result'
    const judging = request.response_format?.json_schema?.name === 'ai_judgment'
    requests.push(planning ? 'planner' : extracting ? 'extraction' : judging ? 'assertion' : 'verifier')
    if (planning) planningCalls++
    if (!planning && !extracting && !judging) verifierCalls++
    if (extracting) {
      extractionStarted = true
      terminalCountAtExtraction = events.filter(event => event.type === 'stepFinalized').length
    }
    return new Response(JSON.stringify({
      id: 'chat-synthetic-423-31', created: 1, model: 'synthetic-routed-model',
      choices: [{ index: 0, finish_reason: planning ? 'tool_calls' : 'stop', message: planning
        ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${planningCalls}`, type: 'function', function: {
            name: planningCalls === 1 ? 'web_click' : 'common_assertAI',
            arguments: JSON.stringify({ ...(planningCalls === 1 ? { ref: 'e2' } : { claim: 'The Log in button is visible' }),
              reasoning: 'Check the button', confidence: 1, stepComplete: true,
              doesActionAdvanceUsTowardsGoal: true }),
          } }] }
        : { role: 'assistant', content: JSON.stringify(extracting
            ? { value: 'captured', reasoning: 'Read from screen' }
            : judging ? { verdict: true, rationale: 'Visible' }
            // A passing assertAI is confirmed by the step verifier, so only the
            // first verifier call, after the click, rejects.
            : verifierCalls === 1 ? { conditions: [{ quote: 'Click and verify Log in', verdict: 'not-met',
                needs: 'none', controlRef: '', file: { name: '', match: 'none', text: '' }, citations: [],
                reasoning: 'Confirm with an assertion' }], dialogs: [], isAppError: false,
              reasoning: 'Confirm with an assertion' }
            : { conditions: [{ quote: 'Click and verify Log in', verdict: 'met', needs: 'none', controlRef: '',
                file: { name: '', match: 'none', text: '' },
                citations: [{ source: 'action', quote: '→ success' }], reasoning: 'Log in is visible' }],
              dialogs: [], isAppError: false, reasoning: 'Log in is visible' }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 7,
        ...(options.omitCache ? {} : { prompt_tokens_details: { cached_tokens: 30 } }) },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', transport)
  const profile: ModelProfile = {
    provider: 'openai-compatible', model: 'gpt-4o', baseURL: 'https://usage-fixture.invalid/v1',
    auth: { mode: 'none' },
  }
  const model = createModel(profile, { kind: 'none' }, mask)
  const accounting = createTokenAccounting({ getCapabilities: () => profile.capabilities! })
  const consumers = (models: { plannerModel: typeof model; verifierModel: typeof model }) => ({
    planner: new LLMPlanner(models.plannerModel, 'web', undefined, undefined, accounting),
    verifier: new LLMVerifier(models.verifierModel, accounting),
  })
  let scope: StepModelScope | undefined
  bus.publish('runStarted', {})
  bus.publish('testStarted', { testIndex: 0, testId, name: 'Usage roundtrip' })
  try {
    const result = await runMemberTest({ testId, name: 'Usage roundtrip', filePath: 'usage.yaml',
      steps: [{ step: 'Click and verify Log in', capture: { variable: '__proto__', method: 'ai' } }],
    }, {
      adapter: { platform: 'web', async setup() {}, async cleanup() {},
        async observe() { return makeScreenState() }, async execute() { return { success: true } } },
      ...consumers({ plannerModel: model, verifierModel: model }), plannerModel: model, verifierModel: model,
      testIndex: 0, abortSignal: new AbortController().signal, evidenceArtifacts: store,
      secretRedactor: redactor,
      sink: createMemberEventSink({ bus, mask, testIndex: 0 }),
      ...(options.unscoped ? {} : { stepModelScope: { runId, create: key => {
        scope = createStepModelScope({ key,
          models: {
            planner: { model, bind: observer => createModel(profile, { kind: 'none' }, mask, {}, observer) },
            verifier: { model, bind: observer => createModel(profile, { kind: 'none' }, mask, {}, observer) },
          },
          profiles: { planner: { provider: profile.provider, modelId: profile.model },
            verifier: { provider: profile.provider, modelId: profile.model } },
          mask,
          createConsumers: models => consumers(models as { plannerModel: typeof model; verifierModel: typeof model }),
        })
        return scope
      } } }),
    })
    expect(result.status).toBe('passed')
    expect(result.steps[0]?.capturedVariables).toEqual({ ['__proto__']: 'captured' })
    expect(requests.filter(value => value !== 'failed-attempt')).toEqual([
      'planner', 'verifier', 'planner', 'assertion', 'verifier', 'extraction',
    ])
    bus.publish('testFinished', { testIndex: 0, outcome: 'passed' })
    bus.publish('runFinished', { aggregateVerdict: 'passed' })
    await ingest.finalize({})
    const finals = events.filter(event => event.type === 'stepFinalized')
    expect(finals).toHaveLength(1)
    expect(events.filter(event => event.type === 'runWarning')).toEqual([])
    db.close()
    const cold = new DashboardDatabase({ dbPath })
    try {
      return { event: finals[0]!.payload as StepFinalizedPayload, events, result,
        rows: cold.readRunDetailRows(runId)!, projection: await detail(cold, runId),
        snapshot: scope?.snapshot(), requests, extractionStarted, terminalCountAtExtraction, store,
      }
    } finally { cold.close() }
  } finally { bus.close(); db.close() }
}

it('USAGE-COLD-ROUNDTRIP: real model attempts survive final event, subscriber and cold read', async () => {
  const run = await usageRun()
  expect(run.event.modelUsage).toMatchObject({ calls: { started: 6, succeeded: 6, failed: 0 },
    inputTokens: 600, outputTokens: 42, cachedInputTokens: 180 })
  expect(run.rows.steps[0]?.modelUsage).toEqual(run.event.modelUsage)
  expect(run.rows.steps[0]?.tokenUsage).toEqual(run.event.tokenUsage)
  expect(run.projection.steps[0]?.modelUsage).toEqual(run.event.modelUsage)
  expect(run.projection.steps[0]?.tokenUsage).toEqual(run.event.tokenUsage)
  expect(JSON.stringify(run.event)).not.toContain('synthetic-routed-model')
  expect(run.event.modelUsage?.roles.planner?.respondingModelIds).toHaveLength(1)
  expect(run.event.modelUsage?.roles.verifier?.respondingModelIds).toHaveLength(1)
})

it('TIMEOUT-DETAIL-ROUNDTRIP: a timeout failure summary lands on the member row and reads back from runs.detail', async () => {
  const runId = asRunId(generateRunId())
  const testId = generateTestId()
  const dbPath = join(dir, `${runId}.db`)
  const db = new DashboardDatabase({ dbPath })
  const redactor = new SecretRedactor(new SecretStore({ UNRELATED: 'synthetic-unrelated-secret-423-42' }))
  const bus = createRunEventBus({ runId })
  const ingest = createDashboardRunIngest({ db, runId })
  bus.subscribe(1, event => ingest.handler(event))
  const summary = 'Step 1/1 "Navigate to test URL" failed: Test timed out after 5ms'
  try {
    bus.publish('runStarted', {})
    bus.publish('testStarted', { testIndex: 0, testId, name: 'Timeout roundtrip' })
    const failureSummary = redactor.redactString(summary)
    expect(failureSummary).toBe(summary)
    bus.publish('testFinished', { testIndex: 0, testId, outcome: 'timeout', failureSummary })
    bus.publish('runFinished', { aggregateVerdict: 'failed' })
    await ingest.finalize({})
  } finally { bus.close(); db.close() }
  const cold = new DashboardDatabase({ dbPath })
  try {
    expect(cold.readRunDetailRows(runId)!.members[0]?.failureSummary).toBe(summary)
    const projection = await detail(cold, runId)
    expect(projection.members).toHaveLength(1)
    expect(projection.members[0]).toMatchObject({ testIndex: 0, outcome: 'timeout' })
    expect(projection.members[0]?.failureSummary).toContain('timed out')
    expect(projection.members[0]?.failureSummary).toBe(summary)
  } finally { cold.close() }
})

it('USAGE-EXTRACTION-FINAL: final publication includes late extraction and own variable names', async () => {
  const run = await usageRun()
  expect(run.extractionStarted).toBe(true)
  expect(run.terminalCountAtExtraction).toBe(0)
  expect(run.event.tokenUsage).toEqual({ promptTokens: 600, completionTokens: 42, totalTokens: 642, cachedInputTokens: 180 })
  expect(run.event.variableSnapshot).toEqual({ ['__proto__']: { value: 'captured', source: 'capture' } })
  expect(run.rows.steps[0]?.variableSnapshot).toEqual(run.event.variableSnapshot)
})

it('USAGE-NO-DOUBLE-COUNT: failed retry remains in the complete population after later success', async () => {
  const run = await usageRun({ retry: true })
  expect(run.requests).toHaveLength(7)
  expect(run.event.modelUsage).toMatchObject({ calls: { started: 7, succeeded: 6, failed: 1 } })
  for (const row of [run.event, run.rows.steps[0]!, run.projection.steps[0]!]) {
    expect(row).not.toHaveProperty('tokenUsage')
    expect(row.modelUsage).not.toHaveProperty('cachedInputTokens')
    expect(row.modelUsage).not.toHaveProperty('inputTokens')
    expect(row.modelUsage).not.toHaveProperty('outputTokens')
  }
  expect(run.rows.steps[0]?.modelUsage).toEqual(run.event.modelUsage)
})

it('USAGE-RAW-ABSENT: SDK normalized cache zero never reaches the cold read', async () => {
  const run = await usageRun({ omitCache: true })
  expect(run.event.tokenUsage).toEqual({ promptTokens: 600, completionTokens: 42, totalTokens: 642 })
  expect(run.rows.steps[0]?.tokenUsage).toEqual(run.event.tokenUsage)
  expect(run.rows.steps[0]?.modelUsage).not.toHaveProperty('cachedInputTokens')
})

it('USAGE-LEGACY-UNSCOPED: old callers keep their original loop token population', async () => {
  const run = await usageRun({ unscoped: true })
  expect(run.event).not.toHaveProperty('modelUsage')
  expect(run.rows.steps[0]).not.toHaveProperty('modelUsage')
  expect(run.event.tokenUsage).toEqual(run.result.steps[0]?.trace?.tokenUsage)
  expect(run.rows.steps[0]?.tokenUsage).toEqual(run.event.tokenUsage)
  expect(run.event.tokenUsage).not.toHaveProperty('cachedInputTokens')
})

it('ARIA-MEMBER-PROXY: real member preserves child extras through buffering and cold read', async () => {
  const run = await usageRun()
  const children = run.events.filter(event => event.type === 'subActionRecorded')
    .map(event => event.payload as SubActionRecordedPayload)
  expect(children).toHaveLength(2)
  expect(run.rows.subActions).toEqual(children)
  for (const child of children) {
    expect(child.ariaEvidence?.state).toBe('present')
    if (child.ariaEvidence?.state === 'present') {
      expect(child.artifactRefs).toContainEqual(child.ariaEvidence.ref)
      expect(JSON.parse(Buffer.from(run.store.getBlob(child.ariaEvidence.ref.sha)!).toString())).toMatchObject({ kind: 'aria' })
    }
  }
})

it('HISTORICAL-USAGE-ABSENT: rows with only scalar token columns retain only their recorded token facts', async () => {
  const dbPath = join(dir, 'usage-history.db')
  seedHistoricalRowsIntoCurrent(dbPath)
  const db = new DashboardDatabase({ dbPath })
  try {
    for (const id of ['old', 'old-null']) {
      const row = db.readRunDetailRows(id)!.steps[0]!
      expect(row).not.toHaveProperty('modelUsage')
      expect(row.tokenUsage?.cachedInputTokens).toBeUndefined()
    }
    expect(db.readRunDetailRows('old')!.steps[0]?.tokenUsage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
    expect(db.readRunDetailRows('old-null')!.steps[0]).not.toHaveProperty('tokenUsage')
  } finally { db.close() }
})

it('USAGE-OPTIONAL-ENVELOPE: independent token/model fields and clearing survive insert, upsert and reopen', async () => {
  const dbPath = join(dir, 'usage-envelope.db')
  const db = new DashboardDatabase({ dbPath })
  const { step } = recorded()
  const tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0 }
  const modelUsage = { roles: {}, calls: { started: 1, succeeded: 0, failed: 1 } }
  try {
    const ingest = createDashboardRunIngest({ db, runId: 'envelope' })
    let seq = 0
    const emit = (payload: StepFinalizedPayload) => ingest.handler({ runId: 'envelope', type: 'stepFinalized', payload, seq: ++seq, ts: Date.now() })
    ingest.handler({ runId: 'envelope', type: 'runStarted', payload: {}, seq: ++seq, ts: Date.now() } as RunEventEnvelope)
    emit({ ...step, stepIndex: 0, tokenUsage })
    emit({ ...step, stepIndex: 1, tokenUsage })
    emit({ ...step, stepIndex: 1, modelUsage })
    emit({ ...step, stepIndex: 2, tokenUsage, modelUsage })
    emit({ ...step, stepIndex: 2 })
    await ingest.finalize({})
  } finally { db.close() }
  const cold = new DashboardDatabase({ dbPath })
  try {
    const [tokenOnly, modelOnly, omitted] = cold.readRunDetailRows('envelope')!.steps
    expect(tokenOnly?.tokenUsage).toEqual(tokenUsage)
    expect(tokenOnly).not.toHaveProperty('modelUsage')
    expect(modelOnly?.modelUsage).toEqual(modelUsage)
    expect(modelOnly).not.toHaveProperty('tokenUsage')
    expect(omitted).not.toHaveProperty('modelUsage')
    expect(omitted).not.toHaveProperty('tokenUsage')
  } finally { cold.close() }
})

it('USAGE-ENVELOPE-AUTHORITY: absent or malformed persisted usage never resurrects scalar totals', () => {
  const dbPath = join(dir, 'usage-authority.db')
  const db = new DashboardDatabase({ dbPath })
  const { step } = recorded()
  db.insertRun({ id: 'authority', name: 'authority', status: 'passed', duration: 0, startedAt: '', endedAt: '' })
  for (let stepIndex = 0; stepIndex < 4; stepIndex++) {
    db.insertRunStep({ ...step, runId: 'authority', stepIndex,
      tokenUsage: { promptTokens: 100, completionTokens: 7, totalTokens: 107 } })
  }
  db.close()
  const raw = open('usage-authority.db')
  const modelUsage = { roles: {}, calls: { started: 1, succeeded: 0, failed: 1 } }
  for (const [stepIndex, envelope] of [
    [0, JSON.stringify({ modelUsage })], [1, '{malformed'], [2, 'null'],
    [3, JSON.stringify({ modelUsage, tokenUsage: { totalTokens: 99 } })],
  ] as const) raw.prepare('UPDATE run_steps SET model_usage_json = ? WHERE step_index = ?').run(envelope, stepIndex)
  raw.close()
  const cold = new DashboardDatabase({ dbPath })
  try {
    const rows = cold.readRunDetailRows('authority')!.steps
    for (const row of rows) expect(row).not.toHaveProperty('tokenUsage')
    expect(rows[0]?.modelUsage).toEqual(modelUsage)
    expect(rows[3]?.modelUsage).toEqual(modelUsage)
    expect(rows[1]).not.toHaveProperty('modelUsage')
    expect(rows[2]).not.toHaveProperty('modelUsage')
  } finally { cold.close() }
})
function open(name: string): DashboardSqliteDatabase {
  const db = createDashboardSqliteDatabase(join(dir, name))
  opened.push(db)
  return db
}
const HISTORICAL_ROWS = `
    INSERT INTO runs (id,name,status,metadata) VALUES ('old','Historical','passed','{"kept":true}');
    INSERT INTO runs (id,name,status) VALUES ('old-null','No optional facts','failed');
    INSERT INTO run_members (run_id,test_index,name,outcome) VALUES ('old',0,'member','passed');
    INSERT INTO run_steps (run_id,test_index,step_index,cache_status,verifier_verdict,self_heal_occurred,brief_digest,prompt_tokens,completion_tokens,total_tokens)
      VALUES ('old',0,0,'miss','{"pass":true,"reasoning":"kept"}',0,'digest',3,4,7);
    INSERT INTO run_steps (run_id,test_index,step_index,cache_status,verifier_verdict,self_heal_occurred,brief_digest)
      VALUES ('old-null',0,0,'hit','{"pass":false,"reasoning":""}',0,'');
    INSERT INTO run_sub_actions (run_id,test_index,step_index,sub_action_index,plan,planned_action,result,screen_state_hash,artifact_refs)
      VALUES ('old',0,0,0,'plan','{"type":"wait"}','{"success":true}','hash','[]');
    INSERT INTO execution_logs (id,run_id,type,name,phase,status,stdout) VALUES ('hook','old','hook','kept','setup','passed','output');
    INSERT INTO token_events (id,model_name,source,prompt_tokens) VALUES ('token','model','live-editor',9);
    INSERT INTO run_artifacts (run_id,kind,schema_version,payload) VALUES ('old','test',1,'{"kept":true}');
`
function seedRefused(db: DashboardSqliteDatabase, stamp = 6): void {
  for (const sql of V2_SQL) db.exec(sql)
  db.exec(`${HISTORICAL_ROWS}
    PRAGMA user_version = ${stamp};
    PRAGMA foreign_keys = ON;
  `)
}
// no older file is upgraded, so historical rows are seeded into the current version.
function seedHistoricalRowsIntoCurrent(dbPath: string, extraSql = ''): void {
  new DashboardDatabase({ dbPath }).close()
  const raw = createDashboardSqliteDatabase(dbPath)
  try { raw.exec(HISTORICAL_ROWS + extraSql) } finally { raw.close() }
}
const tables = ['runs', 'run_members', 'run_steps', 'run_sub_actions', 'execution_logs', 'token_events', 'run_artifacts']
function data(db: DashboardSqliteDatabase) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
function schema(db: DashboardSqliteDatabase) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA table_info(${table})`).all()]))
}
function nullableColumns(db: DashboardSqliteDatabase): void {
  for (const [table, names] of [
    ['run_steps', ['evidence_json', 'variable_snapshot_json', 'model_usage_json']],
    ['run_sub_actions', ['evidence_state_json']],
  ] as const) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string; type: string; notnull: number; dflt_value: unknown}>
    for (const name of names) expect(columns.find(column => column.name === name)).toMatchObject({ name, type: 'TEXT', notnull: 0, dflt_value: null })
  }
}
it('MIGRATION-FRESH: creates the complete nullable current version directly on a SQLite file', () => {
  const db = open('fresh.db')
  runSqliteMigrations(db, MIGRATIONS, SCHEMA_VERSION)
  expect(db.pragma('user_version', { simple: true })).toBe(2)
  nullableColumns(db)
  expect(Object.keys(MIGRATIONS[0]!).sort()).toEqual(['sql', 'version'])
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
})

async function detail(db: DashboardDatabase, runId: string) {
  const forbidden = () => { throw new Error('Cannot reconstruct facts from handoff or config') }
  const registry = createFunctionRegistry({
    deps: {
      runDetail: createDashboardRunDetailReader(db),
      runs: { get: forbidden }, config: { getMasked: forbidden },
    } as unknown as FunctionDeps,
  })
  // no `resolveExecutionContext` registry option and no `grantedScopes`
  // or `safeMode` on the caller; the registry reads none of them.
  return RunDetailProjectionSchema.parse(await invokeFunction(
    registry, RUNS_DETAIL_FUNCTION_ID, { runId: asRunId(runId) },
    { surface: 'dashboard', origin: 'human' },
  ))
}

function recorded() {
  const sha = 'a'.repeat(64)
  const consoleRef = EvidenceArtifactRefSchema.parse({ id: `console-evidence:${sha}`, sha })
  const ariaRef = EvidenceArtifactRefSchema.parse({ id: `aria-state:${sha}`, sha })
  const step: StepFinalizedPayload = {
    testIndex: 0, stepIndex: 1, cacheStatus: 'bypass',
    verifierVerdict: { pass: true, reasoning: 'recorded' }, selfHealOccurred: false,
    briefDigest: 'new-digest', status: 'passed',
    evidence: {
      console: { kind: 'console', state: 'present', ref: consoleRef, counts: { total: 3, errors: 1, warnings: 2 } },
      network: { kind: 'network', state: 'absent', reason: 'failed' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'present', counts: { count: 1 } },
    },
    variableSnapshot: JSON.parse('{"__proto__":{"value":"[secret]","source":"capture"}}'),
  }
  const child: SubActionRecordedPayload = {
    testIndex: 0, stepIndex: 1, subActionIndex: 0, plan: 'recorded',
    plannedAction: { type: 'navigate', to: 'url', url: 'https://example.invalid' },
    result: { success: true }, screenStateHash: 'new-hash',
    artifactRefs: [ariaRef], ariaEvidence: { kind: 'aria', state: 'present', ref: ariaRef },
  }
  return { step, child }
}

it('EVID-OTHER-STAMP: refuses a database stamped 6 untouched; historical NULLs and new subscriber facts survive restart', async () => {
  const raw = open('refused-6.db')
  seedRefused(raw)
  const before = { data: data(raw), schema: schema(raw) }
  expect(() => new DashboardDatabase({ dbPath: join(dir, 'refused-6.db') }))
    .toThrow('user_version 6 is not compatible with schema version 2')
  expect({ data: data(raw), schema: schema(raw) }).toEqual(before)
  expect(raw.pragma('user_version', { simple: true })).toBe(6)
  // A valid historical action, independent of new producer payloads.
  seedHistoricalRowsIntoCurrent(join(dir, 'evidence.db'),
    `UPDATE run_sub_actions SET planned_action = '{"type":"navigate","to":"url","url":"https://example.invalid"}';`)
  const db = new DashboardDatabase({ dbPath: join(dir, 'evidence.db') })
  const { step, child } = recorded()
  try {
    const ingest = createDashboardRunIngest({ db, runId: 'new' })
    let seq = 0
    const emit = (type: RunEventEnvelope['type'], payload: unknown) => ingest.handler({
      runId: 'new', type, payload, seq: ++seq, ts: Date.now(),
    } as RunEventEnvelope)
    emit('runStarted', {})
    emit('testStarted', { testIndex: 0, testId: 'test', name: 'member' })
    // Exercise the upsert path too: the initial row has no optional facts.
    emit('stepFinalized', { ...step, evidence: undefined, variableSnapshot: undefined })
    emit('subActionRecorded', { ...child, ariaEvidence: undefined, artifactRefs: undefined })
    emit('subActionRecorded', child)
    emit('stepFinalized', step)
    await ingest.finalize({})
  } finally { db.close() }
  const cold = new DashboardDatabase({ dbPath: join(dir, 'evidence.db') })
  try {
    const rows = cold.readRunDetailRows('new')!
    expect(rows.steps).toHaveLength(1)
    expect(rows.steps[0]?.evidence).toEqual(step.evidence)
    expect(rows.steps[0]?.variableSnapshot).toEqual(step.variableSnapshot)
    expect(rows.subActions[0]?.ariaEvidence).toEqual(child.ariaEvidence)
    expect(rows.subActions[0]?.artifactRefs).toEqual(child.artifactRefs)
    expect(rows.steps[0]).not.toHaveProperty('tokenUsage')
    expect(rows.steps[0]).not.toHaveProperty('modelUsage')
    const old = await detail(cold, 'old')
    for (const kind of ['console', 'network', 'a11y', 'variables'] as const) {
      expect(old.steps[0]?.evidence?.[kind]).toEqual({ kind, state: 'absent', reason: 'unavailable' })
    }
    expect(old.steps[0]).not.toHaveProperty('variableSnapshot')
    expect(old.subActions[0]?.ariaEvidence).toEqual({ kind: 'aria', state: 'absent', reason: 'unavailable' })
    expect(old.steps[0]?.tokenUsage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
    const absent = await detail(cold, 'old-null')
    expect(absent.steps[0]).not.toHaveProperty('tokenUsage')
    const result = await detail(cold, 'new')
    expect(result.steps[0]?.evidence).toEqual(step.evidence)
    expect(result.steps[0]?.variableSnapshot).toEqual(step.variableSnapshot)
    expect(result.subActions[0]?.ariaEvidence).toEqual(child.ariaEvidence)
  } finally { cold.close() }
  const persisted = open('evidence.db')
  expect(persisted.prepare('SELECT evidence_json, variable_snapshot_json, model_usage_json FROM run_steps WHERE run_id = ?').get('new'))
    .toEqual({ evidence_json: JSON.stringify(step.evidence), variable_snapshot_json: JSON.stringify(step.variableSnapshot), model_usage_json: null })
})

it('EVID-UPSERT-OMISSION: insert and replace mirror defined facts, then omit absent fields', () => {
  const db = new DashboardDatabase({ dbPath: join(dir, 'upsert.db') })
  try {
    db.insertRun({ id: 'new', name: 'new', status: 'passed', duration: 0, startedAt: '', endedAt: '' })
    const { step, child } = recorded()
    const input = { runId: 'new', ...step }
    const subInput = { runId: 'new', ...child }
    db.insertRunStep(input)
    db.insertRunSubAction(subInput)
    expect(db.readRunDetailRows('new')?.steps[0]?.evidence).toEqual(step.evidence)
    expect(db.readRunDetailRows('new')?.subActions[0]?.ariaEvidence).toEqual(child.ariaEvidence)
    const absentStep = { ...input, evidence: undefined, variableSnapshot: undefined }
    const absentChild = { ...subInput, ariaEvidence: undefined, artifactRefs: undefined }
    db.insertRunStep(absentStep)
    db.insertRunSubAction(absentChild)
    const rows = db.readRunDetailRows('new')!
    expect(rows.steps[0]).not.toHaveProperty('evidence')
    expect(rows.steps[0]).not.toHaveProperty('variableSnapshot')
    expect(rows.subActions[0]).not.toHaveProperty('ariaEvidence')
    expect(rows.subActions[0]).not.toHaveProperty('artifactRefs')
  } finally { db.close() }
})

it('ARIA-COLD-READBACK: subscriber preserves ordered child ownership and empty evidence across reopen', async () => {
  const dbPath = join(dir, 'aria-order.db')
  const db = new DashboardDatabase({ dbPath })
  const { step, child } = recorded()
  const children = [0, 1, 2].map(index => {
    const sha = String(index + 1).repeat(64)
    const imageSha = String(index + 4).repeat(64)
    const ref = EvidenceArtifactRefSchema.parse({ id: `aria-state:${sha}`, sha })
    const screenshot = { id: `decision-screenshot:${imageSha}`, sha: imageSha }
    return { ...child, subActionIndex: index,
      screenStateHash: `before-${index}`, screenStateHashAfter: `after-${index}`,
      artifactRefs: index === 2 ? [screenshot] : [screenshot, ref],
      ariaEvidence: index === 2
        ? { kind: 'aria', state: 'absent', reason: 'empty' } as const
        : { kind: 'aria', state: 'present', ref } as const,
    }
  })
  try {
    const ingest = createDashboardRunIngest({ db, runId: 'aria-order' })
    let seq = 0
    const emit = (type: RunEventEnvelope['type'], payload: unknown) => ingest.handler({
      runId: 'aria-order', type, payload, seq: ++seq, ts: Date.now(),
    } as RunEventEnvelope)
    emit('runStarted', {})
    emit('testStarted', { testIndex: 0, name: 'member' })
    emit('stepFinalized', step)
    emit('stepFinalized', { ...step, stepIndex: 2 })
    for (const item of [children[2], children[0], children[1]]) emit('subActionRecorded', item)
    await ingest.finalize({})
  } finally { db.close() }
  const cold = new DashboardDatabase({ dbPath })
  try {
    const output = await detail(cold, 'aria-order')
    expect(output.subActions).toEqual(children)
    expect(output.subActions.filter(item => item.stepIndex === 2)).toEqual([])
    expect(output.steps.find(item => item.stepIndex === 2)).not.toHaveProperty('ariaEvidence')
  } finally { cold.close() }
})
it.each([3, 4, 5, 6])('MIGRATION-NEWER-STAMP: refuses a database stamped %i by name without changing schema, data or version', stamp => {
  const db = open(`history-${stamp}.db`)
  seedRefused(db, stamp)
  const before = { data: data(db), schema: schema(db) }
  expect(() => runSqliteMigrations(db, MIGRATIONS, SCHEMA_VERSION))
    .toThrow(`user_version ${stamp} is not compatible with schema version 2`)
  expect({ data: data(db), schema: schema(db) }).toEqual(before)
  expect(db.pragma('user_version', { simple: true })).toBe(stamp)
})
it('MIGRATION-REOPEN: a published current-version file reopens without executing DDL', () => {
  const db = open('reopen.db')
  runSqliteMigrations(db, MIGRATIONS, SCHEMA_VERSION)
  db.exec(HISTORICAL_ROWS)
  const before = data(db)
  db.close()
  const reopened = open('reopen.db')
  const exec = vi.spyOn(reopened, 'exec')
  expect(() => runSqliteMigrations(reopened, MIGRATIONS, SCHEMA_VERSION)).not.toThrow()
  expect(exec).not.toHaveBeenCalled()
  expect(data(reopened)).toEqual(before)
  nullableColumns(reopened)
})
for (const [name, version] of [['V1', 1], ['FUTURE', 7], ['FUTURE', 17]] as const) {
  it(`MIGRATION-${name}-REFUSE: names unsupported version ${version} and leaves schema/data untouched`, () => {
    const db = open(`refuse-${version}.db`)
    seedRefused(db, version)
    const before = { data: data(db), schema: schema(db) }
    expect(() => runSqliteMigrations(db, MIGRATIONS, SCHEMA_VERSION)).toThrow(`user_version ${version}`)
    expect({ data: data(db), schema: schema(db) }).toEqual(before)
    expect(db.pragma('user_version', { simple: true })).toBe(version)
  })
}
