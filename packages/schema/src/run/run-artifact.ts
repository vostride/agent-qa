// Pure types shared by the dashboard store and `FsRunArtifactStore`; schema takes no core import.

export const RUN_ARTIFACT_SCHEMA_VERSION = 2 as const

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

// A run of several tests outside one suite: each member carries its own source and config.
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
  artifact?: RunArtifactStageInput & {
    kind?: RunArtifactKind
    suiteIndex?: number
  }
}
