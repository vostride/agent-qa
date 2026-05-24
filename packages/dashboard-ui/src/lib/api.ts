import { trackDashboardEntityCreated, trackDashboardLiveModeStarted } from '@/lib/analytics'

export interface RunRow {
  id: string
  name: string
  filePath: string | null
  status: string
  duration: number
  attributes: Record<string, string>
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
  parentRunId: string | null
  attemptNumber: number
  retryCount: number
  maxRetries: number
  createdAt: string
  targetName?: string | null
  tests?: RunRow[]
}

export interface AttributePredicate {
  key: string
  value: string
  mode: 'exact' | 'regex'
}

export interface StepAnnotation {
  clickPoint?: { x: number; y: number }
  boundingBox?: { x: number; y: number; width: number; height: number }
  failureHighlight?: { x: number; y: number; width: number; height: number }
  type: string
  viewport?: { width: number; height: number }
  startPoint?: { x: number; y: number }
  endPoint?: { x: number; y: number }
  direction?: 'up' | 'down' | 'left' | 'right'
  pinchScale?: 'in' | 'out'
}

export interface AccessibilityViolation {
  ruleId: string
  impact: 'minor' | 'moderate' | 'serious' | 'critical'
  description: string
  help: string
  helpUrl: string
  nodes: Array<{ html: string; target: string[] }>
}

export interface SubActionData {
  index: number
  observation: string
  reasoning: string
  plannedAction: unknown
  result: 'success' | 'failure' | 'in-progress'
  error?: string
  screenStateBefore: string
  screenStateAfter?: string
  confidence?: number
  verifierReasoning?: string
  cached: boolean
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  phaseDurations?: { observe?: number; plan?: number; execute?: number; verify?: number }
  screenshotBeforePath?: string
  screenshotAfterPath?: string
  annotation?: StepAnnotation
  screenContextBefore?: string
  screenContextAfter?: string
  data?: unknown
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
  annotationData: StepAnnotation | null
  healingScreenshotPaths: string[] | null
  accessibilityViolations: AccessibilityViolation[] | null
  consoleLogs: Array<{
    level: string
    text: string
    location?: { url: string; lineNumber: number; columnNumber: number }
    timestamp: number
  }> | null
  networkLogs: Array<{
    url: string
    method: string
    status: number
    requestHeaders: Record<string, string>
    responseHeaders: Record<string, string>
    body?: string
    requestBody?: string
    startTime: number
    endTime: number
    timing?: Record<string, number>
  }> | null
  confidence: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  subActionsData: SubActionData[] | null
  variableSnapshot: Record<string, { value: string; source: string }> | null
  originalStepName: string | null
  screenContextBefore: string | null
  screenContextAfter: string | null
  createdAt: string
}

export interface Stats {
  totalRuns: number
  passed: number
  failed: number
  flakeRate: number
  avgDuration: number
  runs: { date: string; passed: number; failed: number; healed: number; duration: number }[]
  scope?: AnalyticsScope
  memory?: {
    runs: number
    added: number
    confirmed: number
    deprecated: number
    deleted: number
    curatorTokens: number
  }
}

export interface RunsFilter {
  status?: string
  name?: string
  platform?: string
  target?: string
  attributes?: AttributePredicate[]
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'

export interface RunArtifactPayload {
  schemaVersion: number
  [key: string]: unknown
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

export interface RunArtifactResponse {
  run: RunRow
  artifact: RunArtifactRow | null
  children: Array<{ run: RunRow; artifact: RunArtifactRow | null }>
  missingSections: string[]
}

export interface LLMProviderMetadata {
  id: string
  label: string
  auth:
    | {
      kind: 'api-key'
      credentialTypes: Array<'api-key' | 'bearer-token'>
      optional?: boolean
    }
    | {
      kind: 'oauth-plugin'
      mode: 'browser-poll' | 'manual-code'
      buttonLabel?: string
    }
  modelAdapter?: 'openai-responses' | 'anthropic-messages'
}

export interface AuthStateMetadata {
  version: 1
  kind: 'web'
  target: string
  name: string
  capturedAt: string
}

function toAuthStateMetadata(value: unknown): AuthStateMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== 1 ||
    candidate.kind !== 'web' ||
    typeof candidate.target !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.capturedAt !== 'string'
  ) {
    return null
  }

  return {
    version: 1,
    kind: 'web',
    target: candidate.target,
    name: candidate.name,
    capturedAt: candidate.capturedAt,
  }
}

const API_BASE = ''

/**
 * Error thrown by api.ts helpers when the server returns a non-OK status with a JSON body.
 * Preserves server-sent structured fields (error, details, missingTests, message) so callers
 * can render rich UX. The `message` property inherits the server's top-level `error` field
 * when available, or falls back to `API error {status}: {statusText}`.
 *
 * Defensive parsing: non-JSON responses produce an ApiError with a null payload; malformed
 * JSON is swallowed. Structured fields are only copied when the payload is a non-null object
 * (primitives and arrays are rejected). See threat model T-181.04-02 / T-181.04-03.
 */
export class ApiError extends Error {
  readonly status: number
  readonly statusText: string
  readonly payload: Record<string, unknown> | null
  readonly details?: unknown
  readonly missingTests?: Array<{ index: number; test: string; id: string }>

  constructor(status: number, statusText: string, payload: Record<string, unknown> | null) {
    const message =
      (payload && typeof payload.error === 'string' && payload.error) ||
      (payload && typeof payload.message === 'string' && payload.message) ||
      `API error ${status}: ${statusText}`
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.statusText = statusText
    this.payload = payload
    if (payload && 'details' in payload) this.details = payload.details
    if (payload && Array.isArray(payload.missingTests)) {
      this.missingTests = payload.missingTests as Array<{ index: number; test: string; id: string }>
    }
  }
}

async function parseErrorPayload(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await res.json()
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    // non-JSON or malformed body — payload stays null; ApiError falls back to statusText
    return null
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = []
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== '') {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`)
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

function appendAttributePredicateQueryParts(parts: string[], predicates: AttributePredicate[] | undefined) {
  for (const predicate of predicates ?? []) {
    if (!predicate.key || !predicate.value) continue
    const paramName = predicate.mode === 'regex'
      ? `attributes[${predicate.key}][regex]`
      : `attributes[${predicate.key}]`
    parts.push(`${encodeURIComponent(paramName)}=${encodeURIComponent(predicate.value)}`)
  }
}

function buildRunsQuery(opts: RunsFilter): string {
  const parts: string[] = []
  for (const [key, val] of Object.entries({
    status: opts.status,
    name: opts.name,
    platform: opts.platform,
    target: opts.target,
    from: opts.from,
    to: opts.to,
    limit: opts.limit,
    offset: opts.offset,
  })) {
    if (val !== undefined && val !== '') {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`)
    }
  }
  appendAttributePredicateQueryParts(parts, opts.attributes)
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) {
    const payload = await parseErrorPayload(res)
    throw new ApiError(res.status, res.statusText, payload)
  }
  return res.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const payload = await parseErrorPayload(res)
    throw new ApiError(res.status, res.statusText, payload)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function fetchRuns(opts: RunsFilter = {}): Promise<{ runs: RunRow[]; total: number; targets?: string[] }> {
  const query = buildRunsQuery(opts)
  return request(`/api/runs${query}`)
}

export interface AttributeKeySuggestion {
  key: string
  count: number
}

export interface AttributeValueSuggestion {
  value: string
  count: number
}

export async function fetchRunAttributeKeys(opts: { q?: string; limit?: number } = {}): Promise<{ keys: AttributeKeySuggestion[] }> {
  const query = buildQuery({ q: opts.q, limit: opts.limit })
  return request(`/api/runs/attributes/keys${query}`)
}

export async function fetchRunAttributeValues(key: string, opts: { q?: string; limit?: number } = {}): Promise<{ values: AttributeValueSuggestion[] }> {
  const query = buildQuery({ key, q: opts.q, limit: opts.limit })
  return request(`/api/runs/attributes/values${query}`)
}

export async function fetchRun(id: string): Promise<{ run: RunRow; steps: StepRow[]; attempts: RunRow[]; tests?: RunRow[] }> {
  return request(`/api/runs/${encodeURIComponent(id)}`)
}

export async function fetchRunArtifact(id: string): Promise<RunArtifactResponse> {
  return request(`/api/runs/${encodeURIComponent(id)}/artifact`)
}

export async function fetchStats(opts: { from?: string; to?: string; scope?: 'passRate' } = {}): Promise<Stats> {
  const query = buildQuery({ from: opts.from, to: opts.to, scope: opts.scope })
  return request(`/api/stats${query}`)
}

export async function fetchAuthStates(opts: { target?: string } = {}): Promise<{ authStates: AuthStateMetadata[] }> {
  const query = buildQuery({ target: opts.target })
  const result = await request<{ authStates?: unknown }>(`/api/auth-states${query}`)
  const authStates = Array.isArray(result.authStates)
    ? result.authStates.map(toAuthStateMetadata).filter((item): item is AuthStateMetadata => item !== null)
    : []
  return { authStates }
}

export async function saveLiveAuthState(
  sessionId: string,
  input: { name: string; replace?: boolean },
): Promise<{ authState: AuthStateMetadata }> {
  const result = await postJson<{ authState?: unknown }>(
    `/api/live-editor/sessions/${encodeURIComponent(sessionId)}/auth-state`,
    input,
  )
  const authState = toAuthStateMetadata(result.authState)
  if (!authState) {
    throw new Error('Invalid auth state response')
  }
  return { authState }
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

export async function fetchInsightsBreakdown(
  dimension: InsightsBreakdownDimension,
  opts: { from?: string; to?: string; limit?: number; scope?: 'passRate' } = {},
): Promise<{ dimension: InsightsBreakdownDimension; rows: InsightsBreakdownRow[]; scope?: AnalyticsScope }> {
  const query = buildQuery({
    dimension,
    from: opts.from,
    to: opts.to,
    limit: opts.limit,
    scope: opts.scope,
  })
  return request(`/api/analytics/breakdowns${query}`)
}

// Queue API

export interface QueueStatus {
  pending: { count: number; jobs: RunRow[] }
  running: { count: number; jobs: RunRow[] }
  concurrency: number
  activeSlots: number
  recent?: RunRow[]
}

export async function fetchQueueStatus(opts?: { completed?: boolean }): Promise<QueueStatus> {
  const query = buildQuery({ completed: opts?.completed ? 'true' : undefined })
  return request(`/api/queue/status${query}`)
}

// Test file API

export interface TestFileInfo {
  path: string
  name: string
  testId: string | null
  targetName: string | null
  platform: string | null
  modified: string
}

export interface TestValidationResult {
  valid: boolean
  errors: { message: string; line?: number; column?: number; suggestion?: string }[]
}

export async function fetchTestFiles(): Promise<{ files: TestFileInfo[]; targets?: string[] }> {
  return request('/api/tests')
}

export async function fetchTestFile(testId: string): Promise<{ path: string; content: string }> {
  return request(`/api/tests/${encodeURIComponent(testId)}`)
}

export async function createTestFile(filePath: string, content: string): Promise<{ path: string; created: boolean }> {
  const result = await postJson<{ path: string; created: boolean }>('/api/tests', { path: filePath, content })
  trackDashboardEntityCreated('test')
  return result
}

export async function updateTestFile(testId: string, content: string): Promise<{ path: string; updated: boolean }> {
  return postJson(`/api/tests/${encodeURIComponent(testId)}`, { content }, 'PUT')
}

export async function deleteTestFile(testId: string): Promise<{ deleted: boolean; path: string }> {
  return postJson(`/api/tests/${encodeURIComponent(testId)}`, undefined, 'DELETE')
}

export async function validateTestContent(content: string, filePath?: string): Promise<TestValidationResult> {
  return postJson('/api/tests/validate', { content, filePath })
}

// Suite file API

export interface SuiteFileInfo {
  path: string
  suiteId: string | null
  name: string
  testCount: number
  modified: string
  platform: string | null
}

export async function fetchSuiteFiles(): Promise<{ files: SuiteFileInfo[] }> {
  return request('/api/suites')
}

export async function fetchSuiteFile(suiteId: string): Promise<{ path: string; content: string; suiteId: string }> {
  return request(`/api/suites/${encodeURIComponent(suiteId)}`)
}

export async function createSuiteFile(filePath: string, content: string): Promise<{ path: string; created: boolean }> {
  const result = await postJson<{ path: string; created: boolean }>('/api/suites', { path: filePath, content })
  trackDashboardEntityCreated('suite')
  return result
}

export async function updateSuiteFile(suiteId: string, content: string): Promise<{ path: string; updated: boolean }> {
  return postJson(`/api/suites/${encodeURIComponent(suiteId)}`, { content }, 'PUT')
}

export async function deleteSuiteFile(filePath: string): Promise<{ deleted: boolean }> {
  return postJson(`/api/suites/${encodeURIComponent(filePath)}`, undefined, 'DELETE')
}

export async function validateSuiteContent(content: string): Promise<TestValidationResult> {
  return postJson('/api/suites/validate', { content })
}

// Live execution API

export interface ActiveExecution {
  runId: string
  status: string
  startedAt: string
  duration: number
  testName?: string
}

export async function fetchActiveExecutions(): Promise<{ executions: ActiveExecution[] }> {
  return request('/api/execution/active')
}

export async function triggerRun(opts: { file?: string; patterns?: string[]; noCache?: boolean; noMemory?: boolean; local?: boolean }): Promise<{ runId: string; status: string }> {
  return postJson('/api/runs/trigger', opts)
}

export async function cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  return postJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {})
}

export async function deleteRun(runId: string): Promise<{ deleted: boolean; deletedRunIds: string[] }> {
  return postJson(`/api/runs/${encodeURIComponent(runId)}`, undefined, 'DELETE')
}

export async function purgeCache(opts: { file?: string; all?: boolean }): Promise<{ purged: number }> {
  return postJson('/api/cache/purge', opts)
}

export interface ExecutionLiveIdentity {
  eventId?: string
  runId: string
  parentRunId?: string | null
  suiteIndex?: number
  suiteTotal?: number
  testIndex?: number
  stepIndex?: number
  stepId?: string
}

export interface ExecutionTestStartEvent extends ExecutionLiveIdentity {
  type: 'test-start'
  testName: string
  filePath: string
  totalSteps: number
  timestamp?: string
}

export interface ExecutionTestCompleteEvent extends ExecutionLiveIdentity {
  type: 'test-complete'
  testName: string
  status: string
  duration: number
}

export interface ExecutionStepStartEvent extends ExecutionLiveIdentity {
  type: 'step-start'
  stepName: string
  testName: string
  timestamp: string
}

export interface ExecutionStepCompleteEvent extends ExecutionLiveIdentity {
  type: 'step-complete'
  stepName: string
  testName?: string
  status: string
  duration: number
  screenshot?: string
  screenshotBefore?: string
  observation?: string
  reasoning?: string
  plannedAction?: unknown
  result?: string
  error?: string
  annotation?: unknown
}

export interface ExecutionStepPhaseEvent extends ExecutionLiveIdentity {
  type: 'step-phase'
  stepName: string
  testName: string
  phase: 'observe' | 'plan' | 'execute' | 'verify' | 'heal'
  subActionIndex?: number
  phaseOrdinal?: number
  text?: string
  confidence?: number
  action?: unknown
  success?: boolean
  duration?: number
  timestamp: string
}

export interface ExecutionHookStartEvent extends Partial<ExecutionLiveIdentity> {
  type: 'hook-start'
  hookId?: string
  hookName: string
  phase: 'setup' | 'teardown' | 'inline'
  hookExecutionId: string
  timestamp: string
}

export interface ExecutionHookEndEvent extends Partial<ExecutionLiveIdentity> {
  type: 'hook-end'
  hookId?: string
  hookName: string
  phase: 'setup' | 'teardown' | 'inline'
  hookExecutionId: string
  status: 'passed' | 'failed'
  duration: number
  stdout?: string
  stderr?: string
  variables?: Record<string, string>
  error?: string
  logType?: 'hook' | 'appium-script' | 'runjs'
  timestamp: string
}

export interface ExecutionRunCompleteEvent {
  type: 'run-complete'
  eventId?: string
  runId: string
  status: string
  duration: number
}

// Test analytics API

export interface TestAnalyticsEntry {
  name: string
  filePath: string | null
  totalRuns: number
  passRate: number
  flakyScore: number
  isFlaky: boolean
}

export interface TestTrends {
  daily: { date: string; passed: number; failed: number; total: number; avgDuration: number }[]
  passRate: number
  totalRuns: number
  avgDuration: number
}

export interface AnalyticsScope {
  configured: boolean
  predicates: AttributePredicate[]
  scopedCount: number
  totalCount: number
}

export interface TestAnalyticsDetail {
  name: string
  runs: RunRow[]
  total: number
  trends: TestTrends
  isFlaky: boolean
  flakyScore: number
  scope?: AnalyticsScope
  scopedTrends?: TestTrends
  scopedFlakyScore?: number
  scopedRuns?: RunRow[]
}

export interface SuiteAnalyticsDetail {
  suiteId: string
  runs: RunRow[]
  total: number
  trends: TestTrends
  isFlaky: boolean
  flakyScore: number
  scope?: AnalyticsScope
  scopedTrends?: TestTrends
  scopedFlakyScore?: number
  scopedRuns?: RunRow[]
}

export async function fetchFlakyTests(opts?: { minRuns?: number; limit?: number }): Promise<{ tests: TestAnalyticsEntry[] }> {
  const query = buildQuery({ minRuns: opts?.minRuns, limit: opts?.limit })
  return request(`/api/analytics/tests${query}`)
}

export async function fetchTestAnalytics(
  name: string,
  opts?: { limit?: number; offset?: number; from?: string },
): Promise<TestAnalyticsDetail> {
  const query = buildQuery({ limit: opts?.limit, offset: opts?.offset, from: opts?.from })
  return request(`/api/analytics/tests/${encodeURIComponent(name)}${query}`)
}

export async function fetchSuiteAnalytics(
  suiteId: string,
  opts?: { limit?: number; offset?: number; from?: string },
): Promise<SuiteAnalyticsDetail> {
  const query = buildQuery({ limit: opts?.limit, offset: opts?.offset, from: opts?.from })
  return request(`/api/analytics/suites/${encodeURIComponent(suiteId)}${query}`)
}

// Cost / token analytics API

export interface CostStatsRun {
  runId: string
  name: string
  startedAt: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface CostStats {
  runs: CostStatsRun[]
  totals: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export async function fetchCostStats(opts?: { from?: string; to?: string }): Promise<CostStats> {
  const query = buildQuery({ from: opts?.from, to: opts?.to })
  return request(`/api/stats/costs${query}`)
}

export interface TokenEventStats {
  byModel: { date: string; model: string; promptTokens: number; completionTokens: number }[]
  bySource: Record<string, { promptTokens: number; completionTokens: number }>
  totals: { promptTokens: number; completionTokens: number }
}

export async function fetchTokenEventStats(opts?: { from?: string; to?: string }): Promise<TokenEventStats> {
  const query = buildQuery({ from: opts?.from, to: opts?.to })
  return request(`/api/token-events/stats${query}`)
}

export interface AccessibilitySummary {
  enabled: boolean | null
  total: number
  bySeverity: { critical: number; serious: number; moderate: number; minor: number }
  byRule: Array<{ ruleId: string; count: number; impact: string }>
  stepsWithViolations: number
  scannedSteps: number
  unscannedSteps: number
  totalSteps: number
}

export interface ReasoningTrace {
  id: string | null
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
  healAttempts: Array<{
    action: unknown
    observationBefore: string
    observationAfter?: string
    success: boolean
    attemptNumber?: number
    strategy?: string
    reasoning?: string
    confidence?: number
  }> | null
  totalDuration: number | null
  screenStateBefore: string | null
  screenStateAfter: string | null
  createdAt: string
}

export async function fetchStepReasoning(
  runId: string,
  stepOrder: number,
): Promise<{ trace: ReasoningTrace }> {
  return request(`/api/runs/${encodeURIComponent(runId)}/steps/${stepOrder}/reasoning`)
}

// Log API

export interface LogEntry {
  id: string
  stepId: string | null
  runId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  source: 'agent' | 'adapter' | 'cache' | 'planner' | 'healer' | 'hook' | 'runner'
  message: string
  data: Record<string, unknown>
  timestamp: string
}

export async function fetchRunLogs(
  runId: string,
  opts?: { stepId?: string; level?: string; source?: string; limit?: number; offset?: number },
): Promise<{ logs: LogEntry[]; total: number }> {
  const query = buildQuery({
    stepId: opts?.stepId,
    level: opts?.level,
    source: opts?.source,
    limit: opts?.limit,
    offset: opts?.offset,
  })
  return request(`/api/runs/${encodeURIComponent(runId)}/logs${query}`)
}

export async function fetchAccessibilitySummary(runId: string): Promise<AccessibilitySummary> {
  return request(`/api/runs/${encodeURIComponent(runId)}/accessibility`)
}

export function subscribeToAllExecutionEvents(
  callbacks: {
    onRunStart?: (data: { runId: string; status: string; eventId?: string }) => void
    onRunComplete?: (data: ExecutionRunCompleteEvent) => void
  },
): EventSource {
  const source = new EventSource(`${API_BASE}/api/execution/events`)

  source.addEventListener('run-start', (e) => {
    callbacks.onRunStart?.(JSON.parse((e as MessageEvent).data))
  })
  source.addEventListener('run-complete', (e) => {
    callbacks.onRunComplete?.(JSON.parse((e as MessageEvent).data))
  })

  return source
}

// Config & LLM settings API

export interface ConfigResponse {
  config: Record<string, unknown>
}

export interface AppMetadataResponse {
  version: string
  update?: {
    latestVersion: string
  }
}

export interface AuthCredentialInfo {
  type: string
  provider: string
  expires: number | null
  source: string
  configName: string
}

export interface AuthStatusResponse {
  credentials: AuthCredentialInfo[]
}

export interface LLMTestResult {
  success: boolean
  error?: string
  message?: string
  authMessage?: string
  unauthenticated?: boolean
  responseTime?: number
  model?: string
  provider?: string
}

export async function fetchConfig(): Promise<ConfigResponse> {
  return request('/api/config')
}

export async function fetchAppMetadata(): Promise<AppMetadataResponse> {
  return request('/api/app-metadata')
}

export async function fetchTargets(): Promise<{ targets: string[] }> {
  return request('/api/config/targets')
}

export async function updateLLMs(
  llms: Array<{
    name: string
    provider: string
    model: string
    baseURL?: string
    providerHeaders?: Record<string, string>
    screenshotSize?: string
    effectiveResolution?: number
  }>,
  defaultLLM: string,
): Promise<{ updated: boolean }> {
  return postJson('/api/config/llms', { llms, defaultLLM }, 'PUT')
}

export async function updateDefaultLLM(name: string): Promise<{ updated: boolean }> {
  return postJson('/api/config/default-llm', { defaultLLM: name }, 'PUT')
}

export async function updateSettings(settings: Record<string, unknown>): Promise<{ updated: boolean }> {
  return postJson('/api/config/settings', settings, 'PUT')
}

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  return request('/api/auth/status')
}

export async function fetchLLMProviders(): Promise<{ providers: LLMProviderMetadata[] }> {
  return request('/api/llm/providers')
}

export async function testLLMConnection(opts: {
  provider: string
  model: string
  baseURL?: string
  configName?: string
  providerHeaders?: Record<string, string>
}): Promise<LLMTestResult> {
  return postJson('/api/llm/test', opts)
}

export async function saveCredential(
  configName: string,
  provider: string,
  type: 'api-key' | 'bearer-token',
  secret: string,
): Promise<{ saved: boolean }> {
  return postJson('/api/auth/credential', { configName, provider, type, secret })
}

export async function startPluginAuth(
  provider: string,
  configName: string,
): Promise<{ authorizeUrl: string; sessionId: string; mode: 'browser-poll' | 'manual-code' }> {
  return postJson(`/api/auth/plugin/${encodeURIComponent(provider)}/start`, { configName })
}

export async function pollPluginAuthResult(
  provider: string,
  sessionId: string,
): Promise<{ status: 'pending' | 'completed' | 'error'; saved?: boolean; error?: string }> {
  return request(`/api/auth/plugin/${encodeURIComponent(provider)}/result?session=${encodeURIComponent(sessionId)}`)
}

export async function exchangePluginAuthCode(
  provider: string,
  sessionId: string,
  code: string,
): Promise<{ status: 'completed'; saved: boolean }> {
  return postJson(`/api/auth/plugin/${encodeURIComponent(provider)}/exchange`, { sessionId, code })
}

export async function deleteAuthCredential(configName: string): Promise<{ deleted: boolean }> {
  return postJson(`/api/auth/${encodeURIComponent(configName)}`, undefined, 'DELETE')
}

export function subscribeToExecutionEvents(
  runId: string,
  callbacks: {
    onRunStart?: (data: { runId: string; status: string; eventId?: string }) => void
    onTestStart?: (data: ExecutionTestStartEvent) => void
    onHookStart?: (data: ExecutionHookStartEvent) => void
    onHookEnd?: (data: ExecutionHookEndEvent) => void
    onStepStart?: (data: ExecutionStepStartEvent) => void
    onStepComplete?: (data: ExecutionStepCompleteEvent) => void
    onStepPhase?: (data: ExecutionStepPhaseEvent) => void
    onTestComplete?: (data: ExecutionTestCompleteEvent) => void
    onRunComplete?: (data: ExecutionRunCompleteEvent) => void
    onRunError?: (data: { runId: string; error: string; eventId?: string }) => void
  },
): EventSource {
  const source = new EventSource(`${API_BASE}/api/execution/events?runId=${encodeURIComponent(runId)}`)
  const parseExecutionEvent = <T extends { eventId?: string }>(e: Event): T => {
    const message = e as MessageEvent
    const parsed = JSON.parse(message.data) as T
    return message.lastEventId ? { ...parsed, eventId: message.lastEventId } : parsed
  }

  source.addEventListener('run-start', (e) => {
    callbacks.onRunStart?.(parseExecutionEvent<{ runId: string; status: string; eventId?: string }>(e))
  })
  source.addEventListener('test-start', (e) => {
    callbacks.onTestStart?.(parseExecutionEvent(e))
  })
  source.addEventListener('hook-start', (e) => {
    callbacks.onHookStart?.(parseExecutionEvent(e))
  })
  source.addEventListener('hook-end', (e) => {
    callbacks.onHookEnd?.(parseExecutionEvent(e))
  })
  source.addEventListener('step-start', (e) => {
    callbacks.onStepStart?.(parseExecutionEvent(e))
  })
  source.addEventListener('step-complete', (e) => {
    callbacks.onStepComplete?.(parseExecutionEvent(e))
  })
  source.addEventListener('step-phase', (e) => {
    callbacks.onStepPhase?.(parseExecutionEvent(e))
  })
  source.addEventListener('test-complete', (e) => {
    callbacks.onTestComplete?.(parseExecutionEvent(e))
  })
  source.addEventListener('run-complete', (e) => {
    callbacks.onRunComplete?.(parseExecutionEvent(e))
    source.close()
  })
  source.addEventListener('run-error', (e) => {
    callbacks.onRunError?.(parseExecutionEvent<{ runId: string; error: string; eventId?: string }>(e))
    source.close()
  })

  return source
}

// Variables API

export async function fetchVariables(): Promise<{ variables: { key: string; value: string }[]; filePath: string | null; error?: string }> {
  return request('/api/variables')
}

export async function updateVariable(opts: { oldKey?: string; key: string; value: string }): Promise<{ updated: boolean }> {
  return postJson('/api/variables', opts, 'PUT')
}

export async function deleteVariable(key: string): Promise<{ deleted: boolean }> {
  return postJson(`/api/variables/${encodeURIComponent(key)}`, undefined, 'DELETE')
}

// Agent Rules API

export interface AgentRulesResponse {
  content: string | null
  filePath: string | null
  error?: string
}

export async function fetchAgentRules(): Promise<AgentRulesResponse> {
  return request('/api/agent-rules')
}

export type HookRuntime = 'node' | 'bun' | 'python' | 'bash'
export type HookFieldName = 'id' | 'name' | 'runtime' | 'file' | 'timeout' | 'network' | 'registry'

export interface HookCatalogEntry {
  id: string
  name: string
  runtime: HookRuntime
  file: string
  timeout: number
  network: boolean
  fileMissing: boolean
}

export interface HookCatalogResponse {
  hooks: HookCatalogEntry[]
  filePath: string | null
  errors: string[]
  missing: boolean
}

export interface HookFieldError {
  field: HookFieldName
  code: string
  message: string
}

export interface HookDetailResponse {
  hook: HookCatalogEntry
  source: string | null
  fieldErrors: HookFieldError[]
}

export interface HookMutationInput {
  id?: string
  name: string
  runtime: HookRuntime
  file: string
  timeout: string
  network?: boolean
}

export interface HookMutationRequest {
  hook: HookMutationInput
  source: string
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

export async function fetchHookCatalog(): Promise<HookCatalogResponse> {
  return request('/api/hooks')
}

export async function fetchHookDetail(hookId: string): Promise<HookDetailResponse> {
  return request(`/api/hooks/${encodeURIComponent(hookId)}`)
}

export async function createHook(payload: HookMutationRequest): Promise<HookDetailResponse> {
  const result = await postJson<HookDetailResponse>('/api/hooks', payload)
  trackDashboardEntityCreated('hook')
  return result
}

export async function updateHook(hookId: string, payload: HookMutationRequest): Promise<HookDetailResponse> {
  return postJson(`/api/hooks/${encodeURIComponent(hookId)}`, payload, 'PUT')
}

export async function deleteHook(
  hookId: string,
  opts: { force?: boolean } = {},
): Promise<HookDeleteResult> {
  const query = buildQuery({ force: opts.force ? 'true' : undefined })
  const res = await fetch(`${API_BASE}/api/hooks/${encodeURIComponent(hookId)}${query}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const payload = await parseErrorPayload(res)
    throw new ApiError(res.status, res.statusText, payload)
  }
  return res.json() as Promise<HookDeleteResult>
}

export async function runHook(hookId: string, payload: HookRunRequest): Promise<HookRunResponse> {
  return postJson(`/api/hooks/${encodeURIComponent(hookId)}/run`, payload)
}

export async function updateAgentRules(content: string): Promise<{ updated: boolean }> {
  return postJson('/api/agent-rules', { content }, 'PUT')
}

export async function createAgentRulesFile(fileName?: string): Promise<{ created: boolean; filePath: string }> {
  return postJson('/api/agent-rules/create', { fileName })
}

// Execution Logs API

export interface ExecutionLogEntry {
  id: string
  runId: string
  stepId: string | null
  type: 'hook' | 'appium-script' | 'runjs'
  name: string
  hookId?: string | null
  phase: 'setup' | 'teardown' | 'inline'
  status: 'running' | 'passed' | 'failed'
  duration: number
  stdout: string | null
  stderr: string | null
  returnData: unknown | null
  variables: Record<string, string> | null
  createdAt: string
}

export interface LiveExecutionLogEntry {
  id: string
  type: 'hook' | 'appium-script' | 'runjs'
  name: string
  hookId?: string | null
  phase: 'setup' | 'teardown' | 'inline'
  status: 'running' | 'passed' | 'failed'
  duration: number
  stdout: string | null
  stderr: string | null
  returnData: unknown | null
  variables: Record<string, string> | null
  createdAt: string
}

export async function fetchExecutionLogs(
  runId: string,
  opts?: { stepId?: string; type?: string }
): Promise<{ logs: ExecutionLogEntry[] }> {
  const query = buildQuery({ stepId: opts?.stepId, type: opts?.type })
  return request(`/api/runs/${encodeURIComponent(runId)}/execution-logs${query}`)
}

// Live editor API

export async function createLiveEditorSession(
  opts: {
    platform?: string
    targetName?: string
    url?: string
    headless?: boolean
    device?: Record<string, unknown>
    useDeviceName?: string
    appState?: 'preserve' | 'reset'
    bundleId?: string
    appPackage?: string
    appActivity?: string
    setupHooks?: string[]
    teardownHooks?: string[]
    entity?: { type: 'suite' | 'test'; id: string }
  },
  signal?: AbortSignal,
): Promise<{ sessionId: string; sessionNumber: number | null }> {
  const res = await fetch('/api/live-editor/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
    signal,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `API error ${res.status}`)
  }
  const body = await res.json()
  const result = {
    sessionId: body.sessionId,
    sessionNumber: typeof body.sessionNumber === 'number' ? body.sessionNumber : null,
  }
  trackDashboardLiveModeStarted({
    platform: opts.platform,
    entityType: opts.entity?.type,
  })
  return result
}

export async function deleteLiveEditorSession(sessionId: string): Promise<{ ok: boolean }> {
  return postJson(`/api/live-editor/sessions/${encodeURIComponent(sessionId)}`, undefined, 'DELETE')
}

export async function fetchLiveEditorSessions(): Promise<{ sessions: Array<{ sessionId: string; platform: string; status: string; currentStep: string | null; currentUrl: string | null; stepsExecuted: number; createdAt: number }> }> {
  const res = await fetch('/api/live-editor/sessions')
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export interface ObservationSummary {
  id: string
  title: string
  content: string
  trust: number
  created: string
  last_confirmed: string
  confirmed_count: number
  contradicted_count: number
  source_test: string
}

export type MemoryScope = 'product' | 'suite' | 'test'

export interface MemoryInvalidFile {
  scope: MemoryScope
  scopeId: string
  filename: string
  code: string
  message: string
}

export interface MemoryAtlasObservation extends ObservationSummary {
  scope: MemoryScope
  scopeId: string
}

export interface MemoryObservationReference {
  kind: 'suite' | 'test' | 'source_test'
  id: string
  label: string
  targetName: string | null
  href: string | null
}

export interface MemoryWorkspaceObservation extends MemoryAtlasObservation {
  updated: string
  scopeRef: MemoryObservationReference | null
  sourceTestRef: MemoryObservationReference | null
}

export interface MemoryScopeCounts {
  product: number
  suite: number
  test: number
}

export interface MemoryCatalogSourceCounts {
  suite: number
  test: number
}

export interface MemoryCatalogProduct {
  productKey: string
  observationCount: number
  scopeCounts: MemoryScopeCounts
  targetReferences: string[]
  sourceCounts: MemoryCatalogSourceCounts
  freshness: string | null
  sourceCoverage: number
}

export interface MemoryScopeSummary {
  scope: MemoryScope
  observationCount: number
  freshness: string | null
  sourceCoverage: number
  scopeIds: string[]
}

export interface MemoryProductDetail extends MemoryCatalogProduct {
  scopes: Record<MemoryScope, MemoryScopeSummary>
  observations: MemoryWorkspaceObservation[]
  invalidFiles: MemoryInvalidFile[]
}

export async function fetchMemoryCatalog(): Promise<{ products: MemoryCatalogProduct[] }> {
  return request('/api/memory/catalog')
}

export async function fetchMemoryProductDetail(product: string): Promise<{ product: MemoryProductDetail }> {
  return request(`/api/memory/products/${encodeURIComponent(product)}`)
}

export async function fetchMemoryScope(
  scope: MemoryScope,
  scopeId: string,
): Promise<{ scope: MemoryScope; scopeId: string; observations: MemoryWorkspaceObservation[]; invalidFiles: MemoryInvalidFile[] }> {
  return request(`/api/memory/scopes/${encodeURIComponent(scope)}/${encodeURIComponent(scopeId)}`)
}

export async function fetchTestObservations(testId: string): Promise<{ observations: ObservationSummary[]; invalidFiles: MemoryInvalidFile[] }> {
  const res = await fetch(`/api/memory/observations/${encodeURIComponent(testId)}`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export async function deleteTestObservation(testId: string, observationId: string): Promise<{ deleted: boolean }> {
  return postJson(`/api/memory/observations/${encodeURIComponent(testId)}/${encodeURIComponent(observationId)}`, undefined, 'DELETE')
}

// Variable suggestion API (env keys, hook names, captured vars)

export async function fetchEnvVarKeys(): Promise<{ keys: string[] }> {
  return request('/api/variables/env')
}

export async function fetchHookNames(): Promise<{ names: string[] }> {
  return request('/api/variables/hooks')
}

export async function fetchCapturedVarNames(testId: string): Promise<{ names: string[] }> {
  return request(`/api/variables/captured/${encodeURIComponent(testId)}`)
}
