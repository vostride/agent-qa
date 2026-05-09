import type { HookDefinition, HookRuntime } from '@vostride/agent-qa-core'

export type HookFieldName = 'id' | 'name' | 'runtime' | 'file' | 'timeout' | 'network' | 'registry'

export interface HookCatalogRow {
  id: string
  name: string
  runtime: HookRuntime
  file: string
  timeout: number
  network: boolean
  fileMissing: boolean
}

export interface HookCatalogResponse {
  hooks: HookCatalogRow[]
  filePath: string
  errors: string[]
  missing: boolean
}

export interface HookFieldError {
  field: HookFieldName
  code: string
  message: string
}

export interface HookMutationInput {
  id?: string
  name: string
  runtime: HookRuntime
  file: string
  timeout: string | number
  network?: boolean
}

export interface HookMutationRequest {
  hook: HookMutationInput
  source: string
}

export interface HookDetailResponse {
  hook: HookCatalogRow
  source: string | null
  fieldErrors: HookFieldError[]
}

export interface HookDraftValidationResult {
  valid: boolean
  fieldErrors: HookFieldError[]
  warnings: HookFieldError[]
}

export interface HookRegistryReadError {
  code: string
  message: string
}

export interface HookDeleteReference {
  kind: 'test' | 'suite' | 'inline-runHook'
  label: string
  path: string
  context: string
}

export interface HookDeleteResult {
  deleted: boolean
  references: HookDeleteReference[]
}

export interface HookRunOverride {
  key: string
  value: string
}

export interface HookRunRequest {
  overrides?: HookRunOverride[]
}

export interface HookRunNetworkLogEntry {
  id: string
  method: string
  url: string
  statusCode: number | null
  durationMs: number | null
  error: string | null
}

export interface HookRunSandboxSummary {
  runtime: HookRuntime
  image: string
  networkMode: 'enabled' | 'disabled'
  dockerVersion?: string | null
  networkLogsAvailable: boolean
  networkLogs: HookRunNetworkLogEntry[]
}

export interface HookRunResponse {
  success: boolean
  status: 'passed' | 'failed'
  executedAt: string
  duration: number
  output: string
  stdout: string
  stderr: string
  error: string | null
  variables: Record<string, string>
  sandbox: HookRunSandboxSummary
}

export interface HookPrepareResult {
  resolvedHooks: Map<string, HookDefinition>
  hookRegistryError?: string
  authoringIssuesById: Map<string, HookFieldError[]>
}
