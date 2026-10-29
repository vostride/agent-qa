import { RUN_EVENT_TYPES, RunsMarkPreviewResultSchema, RunsMarksHistoryResultSchema } from '@vostride/agent-qa-schema'
import type {
  AnalysisGetOutput,
  PostProcessingDisposition,
  PostProcessingStatus,
  RunDetailProjection,
  RunArtifactKind,
  RunEventEnvelope,
  RunKnowledgeProjection,
  RunServiceReadiness,
  RunsLiveUrlResult,
  EditorLiveUrlResult,
  RunsEvidenceInput,
  RunsEvidenceResult,
  RunsMarkInput,
  RunsMarkOutcome,
  RunsMarkPreviewResult,
  RunsMarksHistoryResult,
  ConfigChange,
  ConfigUndoRequest,
  ConfigUndoResult,
  ConfigWriteIssue,
  ConfigWriteRequest,
  ConfigWriteResult,
  LlmConnectRequest,
  LlmConnectResult,
  LlmCredentialMoveRequest,
} from '@vostride/agent-qa-schema'

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
  failureSummary: string | null
  errorLog: string | null
  testId: string | null
  suiteId: string | null
  platform: string
  testFileContent: string | null
  modelName: string | null
  llmProvider: string | null
  attemptNumber: number
  retryCount: number
  maxRetries: number
  createdAt: string
  targetName?: string | null
  tests?: RunRow[]
  members?: RunMemberSummary[]
  memberOutcome?: string | null
}

export interface RunMemberSummary {
  testIndex: number
  testId: string | null
  filePath: string | null
  suiteId: string | null
  name: string | null
  outcome: string | null
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

export interface Stats {
  totalRuns: number
  passed: number
  failed: number
  flakeRate: number
  avgDuration: number
  runs: { date: string; passed: number; failed: number; healed: number; duration: number }[]
  scope?: AnalyticsScope
}

export interface RunsFilter {
  statuses?: readonly string[]
  name?: string
  platform?: string
  target?: string
  attributes?: AttributePredicate[]
  from?: string
  to?: string
  limit?: number
  offset?: number
}

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
  needsBaseURL?: boolean
  authModes?: Array<'api-key' | 'bearer-token' | 'subscription' | 'none'>
  subscription?: boolean
  baseURLPlaceholder?: string
  defaultModel?: string
}

export interface ModelCatalogEntry {
  id: string
  label: string
  vision: boolean
  notes?: string
}

// Equals core's AUTH_STATE_SCHEMA_VERSION; this package does not depend on core.
const AUTH_STATE_METADATA_VERSION = 2

export interface AuthStateMetadata {
  version: typeof AUTH_STATE_METADATA_VERSION
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
    candidate.version !== AUTH_STATE_METADATA_VERSION ||
    candidate.kind !== 'web' ||
    typeof candidate.target !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.capturedAt !== 'string'
  ) {
    return null
  }

  return {
    version: AUTH_STATE_METADATA_VERSION,
    kind: 'web',
    target: candidate.target,
    name: candidate.name,
    capturedAt: candidate.capturedAt,
  }
}

const API_BASE = ''

// Structured fields are copied only from a non-null object payload; non-JSON gives a null payload.
export class ApiError extends Error {
  readonly status: number
  readonly statusText: string
  readonly payload: Record<string, unknown> | null
  readonly details?: unknown
  readonly missingTests?: Array<{ index: number; test: string; id: string }>

  constructor(status: number, statusText: string, payload: Record<string, unknown> | null) {
    // A refused write-back carries the sentence the editors show.
    const writeBackSentence =
      payload?.error === 'marker_written_back' && typeof payload.message === 'string'
        ? payload.message
        : undefined
    const message =
      writeBackSentence ||
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
  for (const status of opts.statuses ?? []) {
    parts.push(`status=${encodeURIComponent(status)}`)
  }
  for (const [key, val] of Object.entries({
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

// The run row only; members and steps come from `fetchRunDetail`.
export async function fetchRun(id: string): Promise<{ run: RunRow }> {
  return request(`/api/runs/${encodeURIComponent(id)}`)
}

// The id is encoded once, because the `/api/runs/:id` catch-all claims every four-segment GET.
export async function fetchRunDetail(id: string): Promise<RunDetailProjection> {
  return request(`/api/runs/${encodeURIComponent(id)}/detail`)
}

export type RunEvidenceRead =
  | { kind: 'read'; result: RunsEvidenceResult }
  | { kind: 'failed'; error: string }

export async function fetchRunEvidence(input: RunsEvidenceInput): Promise<RunEvidenceRead> {
  const query = new URLSearchParams({
    testIndex: String(input.testIndex),
    stepIndex: String(input.stepIndex),
    kind: input.kind,
  })
  if (input.subActionIndex !== undefined) query.set('subActionIndex', String(input.subActionIndex))
  try {
    const result = await request<RunsEvidenceResult>(`/api/runs/${encodeURIComponent(input.runId)}/evidence?${query}`)
    return { kind: 'read', result }
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function markRun(
  runId: string,
  body: Omit<RunsMarkInput, 'runId'>,
): Promise<RunsMarkOutcome> {
  return await postJson(`/api/runs/${encodeURIComponent(runId)}/mark`, body)
}

export type FeedbackReadFailure = 'network' | 'ledger-corrupt' | 'ledger-unavailable' | 'refused' | 'shape'

export type MarkPreviewRead =
  | { kind: 'read'; result: RunsMarkPreviewResult }
  | { kind: 'failed'; reason: FeedbackReadFailure }

export type MarksHistoryRead =
  | { kind: 'read'; result: RunsMarksHistoryResult }
  | { kind: 'failed'; reason: FeedbackReadFailure }

// A 500 naming `MarkLedgerCorruptError` is a corrupt ledger; any other 500 read is unreadable.
function feedbackReadFailure(error: unknown): FeedbackReadFailure {
  if (!(error instanceof ApiError)) return 'network'
  if (error.payload?.error === 'read_failed' && error.payload.reason === 'MarkLedgerCorruptError') return 'ledger-corrupt'
  if (error.status >= 500 && error.payload?.error === 'read_failed') return 'ledger-unavailable'
  return 'refused'
}

// The strict `RunsMarkInputSchema` wants `runId` in the body, so `markRun`'s body is not reused.
export async function fetchMarkPreview(
  runId: string,
  input: Omit<RunsMarkInput, 'runId' | 'note'>,
): Promise<MarkPreviewRead> {
  try {
    const raw = await postJson<unknown>(`/api/runs/${encodeURIComponent(runId)}/mark-preview`, { runId, ...input })
    const parsed = RunsMarkPreviewResultSchema.safeParse(raw)
    return parsed.success ? { kind: 'read', result: parsed.data } : { kind: 'failed', reason: 'shape' }
  } catch (error) {
    return { kind: 'failed', reason: feedbackReadFailure(error) }
  }
}

// `run-not-found`, `ledger-corrupt` and `ledger-unavailable` are 200 reads; wire failures fail.
export async function fetchMarksHistory(runId: string): Promise<MarksHistoryRead> {
  try {
    const raw = await request<unknown>(`/api/runs/${encodeURIComponent(runId)}/marks`)
    const parsed = RunsMarksHistoryResultSchema.safeParse(raw)
    return parsed.success ? { kind: 'read', result: parsed.data } : { kind: 'failed', reason: 'shape' }
  } catch (error) {
    return { kind: 'failed', reason: feedbackReadFailure(error) }
  }
}

// The id is encoded once, because the `/api/runs/:id` catch-all claims every four-segment GET.
export async function fetchRunAnalysis(id: string): Promise<AnalysisGetOutput> {
  return request(`/api/runs/${encodeURIComponent(id)}/analysis`)
}

// One read for the whole tab; the id is encoded once as the catch-all claims four-segment GETs.
export async function fetchRunKnowledge(id: string): Promise<RunKnowledgeProjection> {
  return request(`/api/runs/${encodeURIComponent(id)}/knowledge`)
}

/**
 * What one read of the knowledge door produced.
 *
 * A CLOSED UNION WITH A REFUSAL ARM, on `PostProcessingRead`'s footing above. The projection
 * already answers its own absences as RESULTS — a pruned handoff is `evidence-incomplete`, a
 * project with no store is `knowledgeStore: 'unbound'` — so the only thing left for this union to
 * carry is the case where there is no projection at all: the op unbound on this host, the route
 * down, the read refused. A shape that could only say "here is your panel" would have forced this
 * client to invent an empty run out of a 503.
 */
export type KnowledgeRead =
  | { readonly kind: 'read'; readonly projection: RunKnowledgeProjection }
  | { readonly kind: 'unavailable'; readonly error: string }

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
  passRate: number | null
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

export async function fetchTestFile(testId: string): Promise<{ path: string; content: string; testId: string }> {
  return request(`/api/tests/${encodeURIComponent(testId)}`)
}

export async function createTestFile(filePath: string, content: string): Promise<{ path: string; created: boolean }> {
  const result = await postJson<{ path: string; created: boolean }>('/api/tests', { path: filePath, content })
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

// Not an `ApiError`: the preflight refused before any request, so there is nothing to cancel.
export class RunNotReadyError extends Error {
  constructor(
    /** The one phrase that says WHY, in the reader's terms. Rendered inside `message`. */
    readonly reason: string,
    /** The facts the door reported, when it reported any. Absent when it could not be reached. */
    readonly readiness?: RunServiceReadiness,
  ) {
    super(`The dashboard cannot start a run right now: ${reason}`)
    this.name = 'RunNotReadyError'
  }
}

// Only `service` and `hostComposed` decide; `contractVersion` is unread, so version 1 passes.
function notReadyReason(readiness: RunServiceReadiness): string | undefined {
  if (readiness.service !== 'up') return 'the run service is not up'
  if (!readiness.hostComposed) return 'this dashboard composed no host to run tests with'
  return undefined
}

/** Whether a parsed body is the readiness answer at all — read structurally, never assumed. */
function isReadiness(value: unknown): value is RunServiceReadiness {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.service === 'string'
    && typeof candidate.hostComposed === 'boolean'
}

// Both mean the server has no readiness door, not that it cannot run, so the gate is then a no-op.
const NO_READINESS_DOOR = new Set([404, 503])

// Fails closed on every answer it can read: unreachable, other refusals and unreadable bodies.
async function assertRunReadiness(): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/api/run-readiness`)
  } catch (error) {
    throw new RunNotReadyError(
      `the dashboard server did not answer its readiness check (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (NO_READINESS_DOOR.has(response.status)) return
  if (!response.ok) {
    const payload = await parseErrorPayload(response)
    const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${String(response.status)}`
    throw new RunNotReadyError(`the readiness check was refused (${detail})`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new RunNotReadyError('the readiness answer could not be read')
  }
  if (!isReadiness(body)) {
    throw new RunNotReadyError('the readiness answer was not in a shape this build understands')
  }
  const reason = notReadyReason(body)
  if (reason !== undefined) throw new RunNotReadyError(reason, body)
}

// Every run start passes here, so a not-ready answer stops it before the POST enqueues anything.
export async function triggerRun(opts: { file?: string; patterns?: string[]; noCache?: boolean }): Promise<{ runId: string; status: string }> {
  await assertRunReadiness()
  return postJson('/api/runs/trigger', opts)
}

/** What {@link openRunStream} accepts: which member to watch, and what to do with the frames. */
export interface RunStreamOptions {
  /**
   * The member handle to address, or nothing for the whole run.
   *
   * A PARALLEL RUN IS ONE RUN ID WITH N ATTACHABLE HANDLES. With a handle the stream carries that
   * member's events plus every run-scoped one (the verdict, warnings, `runFinished`), so a handle
   * subscriber still learns that the run ended. Zero is a handle like any other — an
   * `if (opts.handle)` spelling would silently serve member 0 the firehose.
   */
  handle?: number
  // Zero is a resume point meaning replay from the start, not an absent parameter.
  lastEventId?: number
  /** Every surviving envelope, verbatim, in seq order. */
  onEvent?: (event: RunEventEnvelope) => void
  /** Called after the stream closes itself at `runFinished`. */
  onFinished?: (event: RunEventEnvelope) => void
  /**
   * The source's own `error` event, with the source, so a caller can read `readyState`.
   *
   * `EventSource` FLATTENS EVERY TYPED REFUSAL INTO THIS. A 410 replay floor, a 404 unknown run and
   * a dropped socket all arrive here as one wordless event — which is why a page must follow it
   * with {@link classifyRunStreamClose} rather than guess from `readyState`.
   */
  onError?: (event: Event, source: EventSource) => void
}

/**
 * The run-stream query, composed the ONE way both the source and the classifier compose it.
 *
 * `=== undefined`, NEVER truthiness. `handle: 0` is a real member and `lastEventId: 0` is a real
 * resume point; a truthiness guard silently serves member 0 the firehose and silently turns
 * "from the beginning" into "from wherever you like".
 */
function runStreamQuery(opts: { handle?: number; lastEventId?: number }): string {
  const handlePart: Array<[string, string]> = opts.handle === undefined ? [] : [['handle', String(opts.handle)]]
  const resumePart: Array<[string, string]> = opts.lastEventId === undefined ? [] : [['lastEventId', String(opts.lastEventId)]]
  const pairs = [...handlePart, ...resumePart]
  return pairs.length === 0 ? '' : `?${new URLSearchParams(pairs).toString()}`
}

/** The URL BOTH the stream source and the close classifier address. One spelling, one door. */
function runStreamUrl(runId: string, opts: { handle?: number; lastEventId?: number }): string {
  return `${API_BASE}/api/run-stream/${encodeURIComponent(runId)}${runStreamQuery(opts)}`
}

// Listens to every `RUN_EVENT_TYPES` name: `EventSource` dispatches by name and sends no headers.
export function openRunStream(runId: string, opts: RunStreamOptions = {}): EventSource {
  const source = new EventSource(runStreamUrl(runId, opts))

  if (opts.onError) {
    const onError = opts.onError
    source.addEventListener('error', (event) => { onError(event, source) })
  }

  for (const type of RUN_EVENT_TYPES) {
    source.addEventListener(type, (e) => {
      const envelope = JSON.parse((e as MessageEvent).data) as RunEventEnvelope
      opts.onEvent?.(envelope)
      if (type === 'runFinished') {
        // The run's log is complete, so an open socket would carry only heartbeats.
        opts.onFinished?.(envelope)
        source.close()
      }
    })
  }

  return source
}

// The token rides in the result's fragment; the body passes verbatim, never logged or reshaped.
export async function fetchLiveUrl(runId: string, handle = 0): Promise<RunsLiveUrlResult> {
  return request(`/api/runs/${encodeURIComponent(runId)}/live-url?handle=${encodeURIComponent(String(handle))}`)
}

// The token rides in the fragment; refusals arrive as the door's words on `ApiError.message`.
export async function fetchEditorLiveUrl(sessionId: string): Promise<EditorLiveUrlResult> {
  return request(`/api/live-editor/sessions/${encodeURIComponent(sessionId)}/live-url`)
}

// On `replay_floor`, re-attach at `earliestAvailableSeq - 1`; `lost` means the door gave no answer.
export type RunStreamCloseReason =
  | { kind: 'replay_floor'; earliestAvailableSeq: number }
  | { kind: 'unknown_run' }
  | { kind: 'reattach' }
  | { kind: 'lost' }

// `EventSource` reports every refusal as a bare `error`, so this asks the same URL over `fetch`.
export async function classifyRunStreamClose(
  runId: string,
  opts: { handle?: number; lastEventId?: number } = {},
): Promise<RunStreamCloseReason> {
  const controller = new AbortController()
  try {
    const res = await fetch(runStreamUrl(runId, opts), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (res.status === 410) {
      const payload = await parseErrorPayload(res)
      // A floor the door did not send is no floor; inventing one hands the page a bad resume point.
      if (payload?.error === 'replay_floor' && typeof payload.earliestAvailableSeq === 'number') {
        return { kind: 'replay_floor', earliestAvailableSeq: payload.earliestAvailableSeq }
      }
      return { kind: 'lost' }
    }
    if (res.status === 404) {
      const payload = await parseErrorPayload(res)
      // `unknown_run` is the run service's word for "this process never started that". A generic
      // 404 from some other route is a fact about routing, not about a run.
      return payload?.error === 'unknown_run' ? { kind: 'unknown_run' } : { kind: 'lost' }
    }
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      return { kind: 'reattach' }
    }
    return { kind: 'lost' }
  } catch {
    return { kind: 'lost' }
  } finally {
    // Whatever the answer was, this probe never consumes a stream: on the reattach arm the body is
    // a live feed the real `EventSource` is about to open for itself.
    controller.abort()
  }
}

export interface CancelRunAnswer {
  outcome?: 'cancelled' | 'stop-requested' | 'finished'
  status?: string
  message?: string
  cancelled?: false
}

export async function cancelRun(runId: string): Promise<CancelRunAnswer> {
  return postJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {})
}

export async function deleteRun(runId: string): Promise<{ deleted: boolean; deletedRunIds: string[] }> {
  return postJson(`/api/runs/${encodeURIComponent(runId)}`, undefined, 'DELETE')
}

export async function purgeCache(): Promise<{ purged: number }> {
  return postJson('/api/cache/purge', { all: true })
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
  passRate: number | null
  totalRuns: number
  avgDuration: number
}

export interface AnalyticsScope {
  configured: boolean
  predicates: AttributePredicate[]
  scopedCount: number
  totalCount: number
}

export type TestHistoryRun = RunRow & { memberOutcome: string | null }

export interface TestAnalyticsDetail {
  name: string
  runs: TestHistoryRun[]
  total: number
  trends: TestTrends
  isFlaky: boolean
  flakyScore: number
  scope?: AnalyticsScope
  scopedTrends?: TestTrends
  scopedFlakyScore?: number
  scopedRuns?: TestHistoryRun[]
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
  opts: { testId?: string; filePath?: string; limit?: number; offset?: number; from?: string },
): Promise<TestAnalyticsDetail> {
  const query = buildQuery({
    testId: opts.testId,
    filePath: opts.filePath,
    limit: opts.limit,
    offset: opts.offset,
    from: opts.from,
  })
  return request(`/api/analytics/tests/${encodeURIComponent(name)}${query}`)
}

// Each list row's rate and last run, as its viewer reads them.
export interface PassRateCount {
  passRate: number | null
  passed: number
  decided: number
}

export interface SummaryLastRun {
  id: string
  status: string
  startedAt: string | null
  createdAt: string
  duration: number
}

export interface TestSummary extends PassRateCount {
  path: string
  testId: string | null
  lastRun: (SummaryLastRun & { memberOutcome: string | null }) | null
}

export async function fetchTestSummaries(): Promise<{ tests: TestSummary[] }> {
  return request('/api/analytics/test-summaries')
}

export interface SuiteSummary extends PassRateCount {
  path: string
  suiteId: string | null
  lastRun: SummaryLastRun | null
  platform: string | null
  targetName: string | null
}

export async function fetchSuiteSummaries(): Promise<{ suites: SuiteSummary[] }> {
  return request('/api/analytics/suite-summaries')
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
  /** Window run steps that recorded no token counts; absent from an older server. */
  testRunUnmeasuredSteps?: number
}

export async function fetchTokenEventStats(opts?: { from?: string; to?: string }): Promise<TokenEventStats> {
  const query = buildQuery({ from: opts?.from, to: opts?.to })
  return request(`/api/token-events/stats${query}`)
}

export type InsightsKnowledgeChanges =
  | {
      status: 'read'
      runsInWindow: number
      runsRead: number
      runsUnreadable: number
      runsCurationFailed: number
      runsCurationUnfinished: number
      /** Runs still queued or running; runsInWindow counts only settled runs. */
      runsInFlight: number
      truncated?: { read: number; total: number }
      byKind: Partial<Record<string, number>>
    }
  | { status: 'unavailable'; reason: string }

/** What curation changed across the window's runs, read per run from each run's knowledge. */
export async function fetchInsightsKnowledgeChanges(
  opts?: { from?: string; to?: string },
): Promise<InsightsKnowledgeChanges> {
  const query = buildQuery({ from: opts?.from, to: opts?.to })
  try {
    return await request(`/api/insights/knowledge-changes${query}`)
  } catch (error) {
    if (error instanceof ApiError && error.payload?.status === 'unavailable') {
      const reason = error.payload.reason
      return { status: 'unavailable', reason: typeof reason === 'string' ? reason : 'read_failed' }
    }
    throw error
  }
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

// Config & LLM settings API

export interface ConfigResponse {
  config: Record<string, unknown>
}

/** One line of the config file, as the declared mask shows it. */
export interface ConfigFileLine {
  n: number
  text: string
}

/** GET /api/config: the masked config, the file's revision and its lines. */
export interface ConfigReadAnswer extends ConfigResponse {
  provider: string | null
  revision: string
  file: { path: string | null; lines: ConfigFileLine[] }
  fileIssues?: ConfigWriteIssue[]
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

export async function fetchConfig(): Promise<ConfigReadAnswer> {
  return request('/api/config')
}

/** One field-merge write of leaf changes; undoable answers a single-use Undo token. */
export async function applyConfigChanges(
  changes: ConfigChange[],
  options: { undoable?: boolean } = {},
): Promise<ConfigWriteResult> {
  const body: ConfigWriteRequest =
    options.undoable === undefined ? { changes } : { changes, undoable: options.undoable }
  return postJson('/api/config', body, 'PATCH')
}

export async function fetchConfigRevision(): Promise<{ revision: string }> {
  return request('/api/config/revision')
}

export async function undoConfigAction(token: string): Promise<ConfigUndoResult> {
  const body: ConfigUndoRequest = { token }
  return postJson('/api/config/undo', body)
}

export async function fetchAppMetadata(): Promise<AppMetadataResponse> {
  return request('/api/app-metadata')
}

export async function fetchTargets(): Promise<{ targets: string[] }> {
  return request('/api/config/targets')
}

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  return request('/api/auth/status')
}

export async function fetchLLMProviders(): Promise<{ providers: LLMProviderMetadata[] }> {
  return request('/api/llm/providers')
}

export async function fetchModelCatalog(): Promise<{ catalog: Record<string, ModelCatalogEntry[]> }> {
  return request('/api/llm/catalog')
}

export async function fetchLiveModelCatalog(opts: {
  baseURL: string
  configName?: string
  providerHeaders?: Record<string, string>
}): Promise<{ models: ModelCatalogEntry[] }> {
  return postJson('/api/llm/catalog/live', opts)
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

/** Tests a draft model with its typed credential and writes it only on a pass or an explicit skipTest. */
export async function connectLLM(request: LlmConnectRequest): Promise<LlmConnectResult> {
  return postJson('/api/llm/connect', request)
}

export async function saveCredential(
  configName: string,
  provider: string,
  type: 'api-key' | 'bearer-token',
  secret: string,
): Promise<{ saved: boolean; created: boolean }> {
  return postJson('/api/auth/credential', { configName, provider, type, secret })
}

export async function startPluginAuth(
  provider: string,
  configName: string,
): Promise<{ authorizeUrl: string; sessionId: string; mode: 'browser-poll' | 'manual-code'; created?: boolean }> {
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

/** A draft's own sign-in or key follows its name while the name is still editable. */
export async function moveCredential(from: string, to: string, provider: string): Promise<{ moved: boolean }> {
  const body: LlmCredentialMoveRequest = { from, to, provider }
  return postJson('/api/auth/credential/move', body)
}

/** The server holds the removed credential for Undo; the answer carries only the token. */
export async function deleteAuthCredential(
  configName: string,
): Promise<{ deleted: boolean; undo?: { token: string; expiresAt: number } }> {
  return postJson(`/api/auth/${encodeURIComponent(configName)}`, undefined, 'DELETE')
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
  return result
}

// `keepalive` lets the DELETE outlive the page on pagehide, which `postJson` cannot ask for.
export async function deleteLiveEditorSession(
  sessionId: string,
  options: { keepalive?: boolean } = {},
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/live-editor/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    ...(options.keepalive ? { keepalive: true } : {}),
  })
  if (!res.ok) {
    const payload = await parseErrorPayload(res)
    throw new ApiError(res.status, res.statusText, payload)
  }
  if (res.status === 204) return { ok: true }
  return res.json() as Promise<{ ok: boolean }>
}

export async function fetchLiveEditorSessions(): Promise<{ sessions: Array<{ sessionId: string; platform: string; status: string; currentStep: string | null; currentUrl: string | null; stepsExecuted: number; createdAt: number }> }> {
  const res = await fetch('/api/live-editor/sessions')
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
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

// Post-processing chips: one read, a poll floor, and a push channel that only triggers

// Most chain postures emit no chip events here, so this poll is what moves their chips.
export const POST_PROCESSING_POLL_MS = 3000

/**
 * The six ratified chip events, taken from the schema's own list rather than typed out here.
 *
 * A HAND-WRITTEN LIST WOULD BE A SECOND VOCABULARY. `EventSource` dispatches by name, so a name
 * this file spelled slightly differently from the bus would simply never fire, and the page would
 * fall back to the poll floor while every test still passed. Filtering the ratified list by stage
 * prefix means a seventh chip event minted later is listened for the day it exists.
 */
export const POST_PROCESSING_CHIP_EVENTS: readonly string[] = RUN_EVENT_TYPES.filter(
  (type) => type.startsWith('analysis') || type.startsWith('curation'),
)

// `snapshot` is listened for only as a trigger; painting its body would be a second projection.
const POST_PROCESSING_STREAM_EVENTS: readonly string[] = [...POST_PROCESSING_CHIP_EVENTS, 'snapshot']

/** The last failure the run's record holds for one stage — the producer's masked, bounded text. */
export interface PostProcessingStageFailure {
  readonly error?: string
  readonly willRetry?: boolean
}

// An empty key means no failure line; an absent key means the events read refused.
export interface PostProcessingFailures {
  readonly analysis?: PostProcessingStageFailure
  readonly curation?: PostProcessingStageFailure
}

// When chip truth cannot be read, the refusal's own name is the answer, never an all-pending body.
export type PostProcessingRead =
  | {
      readonly kind: 'read'
      readonly status: PostProcessingStatus
      readonly disposition?: PostProcessingDisposition
      readonly failures?: PostProcessingFailures
    }
  | { readonly kind: 'unavailable'; readonly error: string; readonly reason?: string }

/**
 * Has this chain finished, whatever became of it? The server's rule, spelled once more.
 *
 * The door publishes the same predicate, but it publishes it in `dashboard-server` — a package this
 * bundle does not and must not depend on. So the rule is re-stated here from the same two clauses
 * and pinned by cells that feed it the door's own shapes: the notification row is the chain's
 * terminal receipt and outranks the chips, and absent the row, both chips settled says the same
 * thing one layer down.
 */
export function isPostProcessingTerminal(status: PostProcessingStatus): boolean {
  const settled = (chip: PostProcessingStatus['chips']['analysis']): boolean =>
    chip === 'complete' || chip === 'failed'
  if (status.notification !== undefined) return true
  return settled(status.chips.analysis) && settled(status.chips.curation)
}

/** The dedicated live channel for one run's chain. One spelling, one door. */
function postProcessingStreamUrl(runId: string): string {
  return `${API_BASE}/api/runs/${encodeURIComponent(runId)}/post-processing/stream`
}

/** The joined read: the op result, the run's posture and its recorded failure lines. */
function postProcessingReadUrl(runId: string): string {
  return `${API_BASE}/api/runs/${encodeURIComponent(runId)}/post-processing`
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Never rejects, because its caller is a poll; every failure becomes the named `unavailable` arm.
export async function fetchPostProcessing(runId: string): Promise<PostProcessingRead> {
  let res: Response
  try {
    res = await fetch(postProcessingReadUrl(runId))
  } catch {
    return { kind: 'unavailable', error: 'route_unreachable' }
  }

  if (!res.ok) {
    const payload = await parseErrorPayload(res)
    const record = payload ?? {}
    const error = readString(record, 'error') ?? 'post_processing_unavailable'
    const reason = readString(record, 'reason')
    return { kind: 'unavailable', error, ...(reason === undefined ? {} : { reason }) }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { kind: 'unavailable', error: 'malformed_body' }
  }
  if (body === null || typeof body !== 'object') {
    return { kind: 'unavailable', error: 'malformed_body' }
  }

  const record = body as Record<string, unknown>
  const status = record.status
  if (status === null || typeof status !== 'object') {
    return { kind: 'unavailable', error: 'malformed_body' }
  }

  const disposition = record.disposition
  const failures = record.failures
  return {
    kind: 'read',
    status: status as PostProcessingStatus,
    ...(typeof disposition === 'string'
      ? { disposition: disposition as PostProcessingDisposition }
      : {}),
    ...(failures !== undefined && failures !== null && typeof failures === 'object'
      ? { failures: failures as PostProcessingFailures }
      : {}),
  }
}

/** What {@link watchPostProcessing} hands back: every read, and only reads. */
export interface WatchPostProcessingOptions {
  /**
   * Called with the result of EVERY read — the first one, every poll, and every re-read a frame
   * triggered. It is never called with a frame's own bytes, and there is no callback that would.
   */
  readonly onRead: (read: PostProcessingRead) => void
}

// A frame only triggers a re-read; the source opens at most once and is re-decided on every read.
export function watchPostProcessing(runId: string, opts: WatchPostProcessingOptions): () => void {
  let disposed = false
  let streamState: 'unopened' | 'open' | 'closed' = 'unopened'
  let source: EventSource | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  let coalesced = false

  const stopPolling = (): void => {
    if (interval === undefined) return
    clearInterval(interval)
    interval = undefined
  }

  const startPolling = (): void => {
    if (interval !== undefined || disposed) return
    interval = setInterval(() => { void read() }, POST_PROCESSING_POLL_MS)
  }

  /** Shuts the channel for the watcher's LIFE — `closed` is terminal in `streamState`. */
  const closeStream = (): void => {
    source?.close()
    source = undefined
    streamState = 'closed'
  }

  const openStream = (): void => {
    if (streamState !== 'unopened' || disposed) return
    streamState = 'open'
    const opened = new EventSource(postProcessingStreamUrl(runId))
    source = opened
    for (const type of POST_PROCESSING_STREAM_EVENTS) {
      // The handler takes NO argument. There is nowhere for the frame's bytes to go.
      opened.addEventListener(type, () => { void read() })
    }
  }

  const read = async (): Promise<void> => {
    if (disposed) return
    if (inFlight) {
      // A frame that lands mid-read becomes ONE follow-up read, however many arrive: the door's
      // answer is whole-state, so N re-reads for N ticks would ask the same question N times.
      coalesced = true
      return
    }

    inFlight = true
    let result: PostProcessingRead
    try {
      result = await fetchPostProcessing(runId)
    } finally {
      inFlight = false
    }
    if (disposed) return

    if (result.kind === 'unavailable') {
      // Retry at the poll cadence, never tighter, and hold no socket to a door that cannot answer.
      startPolling()
    } else if (isPostProcessingTerminal(result.status)) {
      stopPolling()
      closeStream()
    } else {
      startPolling()
      if (result.disposition === undefined || result.disposition === 'drained') openStream()
      else closeStream()
    }

    opts.onRead(result)

    if (coalesced) {
      coalesced = false
      void read()
    }
  }

  void read()

  return () => {
    disposed = true
    coalesced = false
    stopPolling()
    closeStream()
  }
}
