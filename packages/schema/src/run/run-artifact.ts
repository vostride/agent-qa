// Run-artifact payload type family (Phase 363, D-08 — relocated from core/src/artifacts).
//
// These are PURE, host-API-free types (the schema-package discipline: no globalThis/fetch/fs/
// node:*). They describe the durable "run-artifact document": the config snapshot + test/suite
// source snapshot + terminal errors a run persists. Two consumers share the shapes — the
// dashboard SQLite `run_artifacts` payload (the real document) and the runner-owned
// `FsRunArtifactStore` file-side artifact.json (D-08, RESEARCH Q5) — so the type family lives in
// the lowest shared layer (schema) rather than core. `attributes` is typed structurally as
// `Record<string, string>` (the core `RunAttributes` alias) so schema takes no core dependency.

export const RUN_ARTIFACT_SCHEMA_VERSION = 2 as const

/**
 * What a finalized run artifact is ABOUT (405-11, closing 405-07's deferral).
 *
 * TWO MEMBERS, NOT FOUR. It used to admit a suite parent and a suite child as well. 405-07 narrowed
 * the dashboard store's own column to refuse both — after the parent/child split was retired, a
 * suite's members live under ONE run as handles — so nothing can write either value and the two
 * members were unreachable breadth on every reader. They were left in place then because the UI
 * badge switches on this value and narrowing a union a render site reads belongs with that render
 * site; that edit landed with this one.
 */
export type RunArtifactKind = 'test' | 'unknown'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export interface JsonObject {
  [key: string]: JsonValue
}
export type JsonArray = JsonValue[]

export type ArtifactRecord = Record<string, unknown>

export interface RunArtifactMetadata extends ArtifactRecord {
  // Structurally the core `RunAttributes` alias (Record<string, string>); inlined so schema
  // stays free of a core dependency.
  attributes?: Record<string, string>
}

export interface RunArtifactTerminalError {
  code: string
  message: string
  phase: string
  details?: unknown
}

export interface RunArtifactConfigSnapshot {
  rawConfigContent?: string | null
  parsedConfig?: unknown
  effectiveConfig?: unknown
  envFile?: {
    path: string | null
    content: string | null
    variables: Record<string, string>
  }
  secretsFile?: {
    path: string | null
    status: 'loaded' | 'missing' | 'unreadable' | 'invalid'
    count?: number
  } | null
  cliVars?: Record<string, string>
  inlineVars?: Record<string, string>
  hooks?: Array<{ id: string; name: string; runtime?: string; sourcePath?: string }>
  model?: {
    planner?: { provider?: string; model?: string }
    verifier?: { provider?: string; model?: string }
  }
  runtime?: ArtifactRecord
  timeouts?: ArtifactRecord
  cache?: ArtifactRecord
  memory?: ArtifactRecord
}

export interface RunArtifactTestSourceSnapshot {
  kind: 'test'
  testId?: string | null
  name?: string | null
  filePath?: string | null
  rawYaml?: string | null
  resolvedDefinition?: unknown
  loadStatus?: 'queued' | 'loaded' | 'parse-error' | 'setup-error' | 'runtime-error' | 'missing' | 'validation-error' | 'skipped'
  error?: RunArtifactTerminalError
}

export interface RunArtifactSuiteMemberSnapshot {
  index: number
  ref: { test: string; id?: string }
  filePath?: string | null
  testId?: string | null
  name?: string | null
  target?: string | null
  rawYaml?: string | null
  resolvedDefinition?: unknown | null
  loadStatus: 'loaded' | 'missing' | 'parse-error' | 'validation-error' | 'skipped'
  error?: RunArtifactTerminalError
  childRunId?: string
  skipReason?: string
  config?: RunArtifactConfigSnapshot | ArtifactRecord
}

export interface RunArtifactSuiteSourceSnapshot {
  kind: 'suite'
  suiteId?: string | null
  name?: string | null
  filePath?: string | null
  rawYaml?: string | null
  resolvedDefinition?: unknown
  loadStatus?: 'queued' | 'loaded' | 'parse-error' | 'setup-error' | 'runtime-error' | 'missing' | 'validation-error' | 'skipped'
  members?: RunArtifactSuiteMemberSnapshot[]
  error?: RunArtifactTerminalError
}

// 2026-10-17 (444-03, D-07): a run of several tests outside one suite; each member carries its own
// source and config, and the run holds none of its own.
export interface RunArtifactTestsSourceSnapshot {
  kind: 'tests'
  members: RunArtifactSuiteMemberSnapshot[]
}

export interface RunArtifactRuntimeSnapshot extends ArtifactRecord {
  status?: string
  duration?: number
  startedAt?: string
  endedAt?: string
  failureSummary?: string | null
}

export interface RunArtifactPayload {
  schemaVersion: typeof RUN_ARTIFACT_SCHEMA_VERSION
  config?: RunArtifactConfigSnapshot | ArtifactRecord
  source?:
    | RunArtifactTestSourceSnapshot
    | RunArtifactSuiteSourceSnapshot
    | RunArtifactTestsSourceSnapshot
    | ArtifactRecord
  // The resolved target names the run's tests ran on, sorted and unique.
  targets?: string[]
  runtime?: RunArtifactRuntimeSnapshot
  errors?: RunArtifactTerminalError[]
  metadata?: RunArtifactMetadata
}

export interface RunArtifactStageInput extends Partial<Omit<RunArtifactPayload, 'schemaVersion'>> {
  schemaVersion?: typeof RUN_ARTIFACT_SCHEMA_VERSION
}

export interface RunArtifactFinalizeInput extends RunArtifactStageInput {
  finalizedAt?: string
}

export interface RunArtifactReporterContext {
  runId?: string
  parentRunId?: string | null
  artifact?: RunArtifactStageInput & {
    kind?: RunArtifactKind
    suiteIndex?: number
    parentRunId?: string | null
  }
}
