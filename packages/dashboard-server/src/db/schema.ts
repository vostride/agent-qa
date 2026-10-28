// The dashboard's durable schema (Phase 405 plans 01 and 07, D-01/D-02).
//
// Every `user_version` other than `SCHEMA_VERSION` is refused on open, never upgraded.
//
// 2026-08-27 (405-07, D-02) — THE CENSUS RAN AND THE V1 DEBRIS IS GONE. Plan 01 left the dormant
// v1 projection tables and the unfed `runs` columns spelled here on purpose, so that the deletion
// could be a MEASUREMENT rather than a guess taken in the same commit that added their successors.
// The two-predicate census (402 D-11's idiom: "required" = a producer on the shipped in-process
// core AND a reader on the rebuilt page) then scored each one, and everything it scored zero on
// left with its readers in this plan:
//
//   - the three v1 projection tables and their indexes — no producer since the subscriber was
//     rebuilt on the bus payloads, and no reader once `/steps`, `/steps/:n/reasoning`, `/logs` and
//     `/accessibility` were retired in favour of `runs.detail`;
//   - the run-level video column — no producer at all (D-14: refs are the only artifact
//     addressing, and no ref producer mints a recording yet, so the honest state is no column
//     rather than a column nothing fills);
//   - the four parent/attempt/retry columns and their index — nothing has written a child run row
//     since 402-09 put one `runs` row per run and moved member identity onto `run_members`.
//
// WHAT SURVIVED IS WHAT THE CENSUS MEASURED A LIVE PRODUCER AND READER FOR: `execution_logs` (the
// subscriber's `hookFinished` arm → the hook panel), `token_events` (the live-editor ws handler →
// the insights page — D-20's verdict, measured, not assumed), and the construction-data columns on
// `runs` that the queue and the settle path write.
export const SCHEMA_VERSION = 2

export interface DashboardMigration {
  version: number
  sql: string[]
}

export const MIGRATIONS: DashboardMigration[] = [
  {
    version: 2,
    sql: [
      `CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file_path TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','running','passed','healed','failed','timeout','cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        duration INTEGER NOT NULL DEFAULT 0,
        attributes TEXT NOT NULL DEFAULT '{}',
        environment TEXT,
        metadata TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        failure_summary TEXT,
        platform TEXT DEFAULT 'web',
        test_file_content TEXT,
        model_name TEXT,
        llm_provider TEXT,
        parallel INTEGER DEFAULT 0,
        error_log TEXT,
        test_id TEXT,
        suite_id TEXT,
        owner_pid INTEGER,
        owner_incarnation TEXT,
        owner_host TEXT,
        CHECK (status <> 'running' OR owner_pid IS NOT NULL)
      )`,
      `CREATE TABLE IF NOT EXISTS execution_logs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id TEXT,
        type TEXT NOT NULL CHECK(type IN ('hook', 'appium-script', 'runjs')),
        name TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('setup', 'teardown', 'inline')),
        status TEXT NOT NULL CHECK(status IN ('passed', 'failed')),
        duration INTEGER NOT NULL DEFAULT 0,
        stdout TEXT,
        stderr TEXT,
        return_data TEXT,
        variables TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        hook_id TEXT,
        -- 405 D-01: where in the run tree this hook ran. Sourced from HookFinishedPayload's own
        -- optional testIndex/stepIndex; NULL means a run-scoped hook, which is a real state and
        -- not a missing value.
        test_index INTEGER,
        step_index INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS token_events (
        id TEXT PRIMARY KEY,
        model_name TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL CHECK(source IN ('test-run', 'live-editor')),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS run_artifacts (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        -- 2026-08-27 (405-07, RESEARCH Open Q4): TWO KINDS, because two is all anything mints.
        -- The set used to admit two more, named for the parent/child run tree 402-09 retired; no
        -- writer has produced either since, so admitting them was the schema agreeing to store a
        -- distinction the product no longer makes.
        kind TEXT NOT NULL CHECK(kind IN ('test', 'unknown')),
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        finalized_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      // ---- The v2 bus-shaped projection (405 D-01) ----------------------------------------
      //
      // THE COLUMNS ARE THE PAYLOAD'S OWN NAMES, snake_cased and nothing else. No field is
      // re-derived, renamed or re-interpreted on the way in — that is D-01's whole claim, and
      // it is what makes the read a mirror rather than a second opinion. Nested payload objects
      // (`planned_action`, `grounding`, `result`, `artifact_refs`) are `JSON.stringify` of the
      // field VERBATIM; the projection never reaches inside one.
      //
      // `test_index` IS THE HANDLE (RESEARCH D4). `handleId(runId, testIndex)` is how this
      // product spells run-scoped member identity, so minting a second id here would be a
      // second spelling of the same fact.
      `CREATE TABLE IF NOT EXISTS run_members (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        test_index INTEGER NOT NULL,
        test_id TEXT,
        name TEXT,
        file_path TEXT,
        suite_id TEXT,
        suite_name TEXT,
        suite_index INTEGER,
        total_steps INTEGER,
        outcome TEXT,
        duration_ms INTEGER,
        failure_summary TEXT,
        retry_count INTEGER,
        -- D-17 ordinal. Starts at 1 and rises on testRetryScheduled; never reset by an upsert.
        attempts INTEGER NOT NULL DEFAULT 1,
        recording_json TEXT,
        PRIMARY KEY (run_id, test_index)
      )`,
      // The token columns are NULLABLE AND NEVER DEFAULT 0 (D-05/D-06). The retired v1 projection
      // declared these `INTEGER DEFAULT 0`, and that zero was a measurement nobody made — the exact
      // lie this shape refuses to be able to tell. 405-04 landed the producer, so a step the runner
      // measured carries real counts and a step it did not carries NULL, which stays honest.
      `CREATE TABLE IF NOT EXISTS run_steps (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        test_index INTEGER NOT NULL,
        step_index INTEGER NOT NULL,
        step_text TEXT,
        cache_status TEXT NOT NULL,
        verifier_verdict TEXT NOT NULL,
        self_heal_occurred INTEGER NOT NULL,
        brief_digest TEXT NOT NULL,
        status TEXT,
        duration_ms INTEGER,
        error TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        evidence_json TEXT,
        variable_snapshot_json TEXT,
        model_usage_json TEXT,
        PRIMARY KEY (run_id, test_index, step_index)
      )`,
      // NO FOREIGN KEY TO `run_steps`, deliberately: `subActionRecorded` envelopes PRECEDE the
      // `stepFinalized` for their own step by construction, so a constraint pointing at a row
      // that does not exist yet would drop every sub-action of every step.
      `CREATE TABLE IF NOT EXISTS run_sub_actions (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        test_index INTEGER NOT NULL,
        step_index INTEGER NOT NULL,
        sub_action_index INTEGER NOT NULL,
        plan TEXT NOT NULL,
        planned_action TEXT NOT NULL,
        grounding TEXT,
        result TEXT NOT NULL,
        screen_state_hash TEXT NOT NULL,
        screen_state_hash_after TEXT,
        artifact_refs TEXT,
        evidence_state_json TEXT,
        recording_offset_ms REAL,
        PRIMARY KEY (run_id, test_index, step_index, sub_action_index)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_run_members_run ON run_members(run_id)',
      'CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, test_index)',
      'CREATE INDEX IF NOT EXISTS idx_run_sub_actions_run ON run_sub_actions(run_id, test_index, step_index)',
      'CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)',
      'CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at)',
      'CREATE INDEX IF NOT EXISTS idx_runs_name ON runs(name)',
      'CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(status, priority, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_execution_logs_run_id ON execution_logs(run_id)',
      'CREATE INDEX IF NOT EXISTS idx_execution_logs_step_id ON execution_logs(step_id)',
      'CREATE INDEX IF NOT EXISTS idx_execution_logs_type ON execution_logs(type)',
      'CREATE INDEX IF NOT EXISTS idx_token_events_model ON token_events(model_name)',
      'CREATE INDEX IF NOT EXISTS idx_token_events_source ON token_events(source)',
      'CREATE INDEX IF NOT EXISTS idx_token_events_created ON token_events(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_run_artifacts_kind ON run_artifacts(kind)',
      'CREATE INDEX IF NOT EXISTS idx_run_artifacts_finalized ON run_artifacts(finalized_at)',
    ],
  },
]
