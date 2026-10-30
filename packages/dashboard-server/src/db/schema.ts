// Every `user_version` other than `SCHEMA_VERSION` is refused on open, never upgraded.
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
        -- Where in the run tree this hook ran; NULL means a run-scoped hook, not a missing value.
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
        -- Two kinds, because no writer mints any other.
        kind TEXT NOT NULL CHECK(kind IN ('test', 'unknown')),
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        finalized_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      // Columns are the payload's names snake_cased; `test_index` is the handle, so no second id.
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
        -- Starts at 1 and rises on testRetryScheduled; never reset by an upsert.
        attempts INTEGER NOT NULL DEFAULT 1,
        recording_json TEXT,
        PRIMARY KEY (run_id, test_index)
      )`,
      // Token columns are nullable with no default, so a step nobody measured carries NULL, not 0.
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
