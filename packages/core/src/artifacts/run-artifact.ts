import type { RunAttributes } from '../run-attributes.js'

export const RUN_ARTIFACT_SCHEMA_VERSION = 1 as const

export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export interface JsonObject {
  [key: string]: JsonValue
}
export type JsonArray = JsonValue[]

export type ArtifactRecord = Record<string, unknown>

export interface RunArtifactMetadata extends ArtifactRecord {
  attributes?: RunAttributes
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

export interface RunArtifactRuntimeSnapshot extends ArtifactRecord {
  status?: string
  duration?: number
  startedAt?: string
  endedAt?: string
  videoPath?: string | null
  failureSummary?: string | null
}

export type RunArtifactMemoryDeltaAction = 'add' | 'confirm' | 'deprecate' | 'delete'

export interface RunArtifactMemoryObservationSnapshot {
  id: string
  title: string
  content: string
  trust: number
  created: string
  last_confirmed: string
  confirmed_count: number
  contradicted_count: number
  source_test: string
  position?: number
  suite_snapshot?: Array<{ test: string; id: string }>
}

export interface RunArtifactMemoryDelta {
  action: RunArtifactMemoryDeltaAction
  tier: 'products' | 'suites' | 'tests'
  scope: string
  observationId: string
  reasoning: string
  before: RunArtifactMemoryObservationSnapshot | null
  after: RunArtifactMemoryObservationSnapshot | null
  error?: string
}

export interface RunArtifactMemorySnapshot {
  log?: {
    added: number
    confirmed: number
    deprecated: number
    deleted?: number
    deltas?: RunArtifactMemoryDelta[]
    errors: string[]
    curatorDuration: number
    tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  }
  aggregate?: ArtifactRecord
}

export interface RunArtifactPayload {
  schemaVersion: typeof RUN_ARTIFACT_SCHEMA_VERSION
  config?: RunArtifactConfigSnapshot | ArtifactRecord
  source?: RunArtifactTestSourceSnapshot | RunArtifactSuiteSourceSnapshot | ArtifactRecord
  runtime?: RunArtifactRuntimeSnapshot
  memory?: RunArtifactMemorySnapshot | ArtifactRecord
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
