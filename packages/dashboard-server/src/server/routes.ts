import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, basename, resolve, dirname } from 'node:path'

import type { AttributePredicate, DashboardDatabase, InsightsBreakdownDimension, RunArtifactRow, RunRow } from '../db/database.js'
import { isRunStatusWord, memberOutcomeClass, runStatusClass, type RunStatusClass } from '../db/run-status-class.js'
import type { ExecutionBackend } from '../execution/execution-backend.js'
import type { JobQueue } from '../queue/job-queue.js'
import {
  extractTestFileMetadata,
  targetsForMarkerCheck,
  type SupportedPlatform,
  type TestFileManager,
} from '../tests/test-file-manager.js'
import type { SuiteFileManager } from '../tests/suite-file-manager.js'
import { readConfigValues, type ConfigManager } from '../config/index.js'
import { holdsShownMarker } from '../config/config-manager.js'
import { createUndoStore, UNDO_RETENTION_MS } from '../config/undo-store.js'
import { HookRegistryManager, isHookRegistryMutationError } from '../hooks/hook-registry-manager.js'
import { readJsonBody } from './body-parser.js'
import {
  LiveNavigationTimeoutRefusedError,
  LivePlannerLimitsRefusedError,
  resolveLiveNavigationTimeoutMs,
  resolveLivePlannerLimits,
} from '../live-editor/live-session.js'
import { refuseCrossSiteRequest } from './cross-site.js'
import { tryParseRequestUrl } from './request-url.js'
import type { AgentHost } from '../chat/host.js'
import {
  classifyProviderError,
  extractProviderError,
  LlmCredentialMoveRequestSchema,
  MARKER_WRITTEN_BACK_SENTENCE,
  maskPayloadStrings,
  maskPayloadTree,
  parseHandleParam,
  providerErrorSentence,
  RecordChangeSchema,
  RunsPostProcessingInputSchema,
} from '@vostride/agent-qa-schema'
import type {
  EditorLiveUrlResult,
  MaskFn,
  PostProcessingStatus,
  RunServiceReadiness,
  RunSession,
  RunsLiveUrlResult,
} from '@vostride/agent-qa-schema'
import {
  handleParamOf,
  lastEventIdParamOf,
  resumePointOf,
  serveRunEventStream,
} from '../run-service/run-service-routes.js'
// 404-05 (D-16/D-18): the post-processing pair — the read a page polls and the dedicated live
// channel. Two arms below, both above the `/api/runs/:id` catch-all, both formatting nothing.
import {
  servePostProcessingRead,
  servePostProcessingStream,
} from '../run-service/post-processing-routes.js'
// 405-05 (D-12/D-13): the ref-resolving artifact read, on the arm below's own footing — the bytes
// cross the function layer and this file constructs no evidence store.
// 405-01 (D-03): the durable run-detail read. One arm below, above the `/api/runs/:id` catch-all,
// formatting nothing and opening no database.
import {
  serveRunArtifact,
  serveRunDetailRead,
  serveRunEvidenceRead,
  serveRunMarkPreviewRead,
  serveRunMarksHistoryRead,
} from '../run-service/run-detail-routes.js'
// 406-01 (D-04): the failure view's read. One arm below, beside the detail arm and above the
// `/api/runs/:id` catch-all, formatting nothing and opening no database.
import { serveRunAnalysisRead } from '../run-service/run-analysis-routes.js'
// 407-01 (D-05): the Knowledge panel's read — what a run used and learned. One arm below, beside
// the analysis arm and above the `/api/runs/:id` catch-all, formatting nothing and opening no
// database.
import { readRunKnowledge, serveRunKnowledgeRead } from '../run-service/run-knowledge-routes.js'
import { registerRunMarkRoute } from '../run-service/run-mark-routes.js'
import {
  registerConfigRevisionRoute,
  registerConfigUndoRoute,
  registerConfigWriteRoute,
} from './config-routes.js'
import { createConnectInFlight, registerLlmConnectRoute } from './llm-connect-route.js'
import type { PostProcessingRelay } from '../execution/post-processing-relay.js'
import type { LLMAuthProviderPlugin, OAuthTokens } from '@vostride/agent-qa-core'
import { AuthStateNameSchema, buildInternalRunAttributes, DEFAULT_AGENT_QA_CACHE_DIR, mergeRunAttributes, readAuth, writeAuth, removeAuth, getAgentQaVersion, getAgentQaUpdateStatus, getLLMAuthProviderPlugin, listAuthStateMetadata, listLLMAuthProviderPlugins, ModelConfigSchema, NameSlugSchema, TimeoutConfigSchema, AgentQaConfigSchema, TestDefinitionSchema, SuiteDefinitionSchema, parseEnvFile, serializeEnvFile, parseHooksFile, hookRunnerImage, validateUserRunAttributes, discoverWorkspaceFiles, isWorkspacePathMatch, resolveWorkspaceFileTarget, SizeString } from '@vostride/agent-qa-core'
import { SecretStore, SecretRedactor } from '@vostride/agent-qa-runner'
import { DockerHookExecutor, purgeActionCache } from '@vostride/agent-qa-runner-local'
import type { ResolvedWorkspacePaths, RunAttributes, WorkspaceFileKind, WorkspaceFileRecord } from '@vostride/agent-qa-core'
import { createModel, fetchLiveModels, getModelCatalog, listProviders, mergeCatalog, resolveVisionConfig, type ProviderDescriptor } from '@vostride/agent-qa-model'
import { parse as parseYaml } from 'yaml'
import { toModelProfileAndAuth, type DashboardLLMConfig } from '../llm-model-mapping.js'

const LLM_PROVIDER_MODES = new Set([
  'openai-compatible',
  'anthropic-compatible',
  'gemini',
])
const API_KEY_CREDENTIAL_PROVIDERS = new Set([
  'openai-compatible',
  'anthropic-compatible',
  'gemini',
])
const DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS = 60_000
const REMOTE_LLM_CONNECTION_TEST_TIMEOUT_MS = 10_000
const LOCAL_COMPATIBLE_LLM_CONNECTION_TEST_TIMEOUT_MS = 120_000
const LOCAL_COMPATIBLE_LLM_PROVIDERS = new Set(['openai-compatible', 'anthropic-compatible'])
const PLUGIN_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
// 2026-08-17 (Phase 398 plan 11, D-18/D-20): the three v33 dashboard product events, the
// `POST /api/analytics/events` ingest route that took them and the core-analytics bridge it
// captured through are all GONE. `routes.analytics-events.test.ts` holds the drop: the path 404s
// and this file is pinned against the capture vocabulary returning. The dashboard's own run-history
// reporting under `/api/analytics/tests|suites|breakdowns` is unrelated and stays. M5's dashboard
// rebuild decides what it wants to emit, against the new `AnalyticsPort`.

type DashboardExecutionTimeoutSource =
  | 'test.use.timeout.test'
  | 'suite.use.timeout.test'
  | 'config.use.timeout.test'
  | 'none'

interface DashboardExecutionTimeout {
  timeoutMs?: number
  source: DashboardExecutionTimeoutSource
  baseTimeoutMs?: number
  bufferMs?: number
}

function toProductProviderLabel(provider: string): string {
  const plugin = listLLMAuthProviderPlugins()
    .find((candidate) => candidate.credentialProviderId === provider)
  return plugin?.providerId ?? provider
}

function isKnownLLMProvider(provider: string): boolean {
  return LLM_PROVIDER_MODES.has(provider) || Boolean(getLLMAuthProviderPlugin(provider))
}

type CredentialTarget =
  | { ok: true; configName: string; created: boolean }
  | { ok: false; status: number; error: string; message?: string }

type CredentialNameCheck =
  | { ok: true; name: string }
  | { ok: false; status: number; error: string; message?: string }

// 429-09 D-15/D-16: auth.json is machine-wide and keyed by name, so every name passes core's
// name rule before the store is read or written.
function checkCredentialName(configName: unknown): CredentialNameCheck {
  const name = typeof configName === 'string' ? configName.trim() : ''
  if (!name) return { ok: false, status: 400, error: 'configName is required' }
  const parsed = NameSlugSchema.safeParse(name)
  if (!parsed.success) {
    return { ok: false, status: 400, error: 'name_invalid', message: parsed.error.issues[0]?.message ?? 'Invalid name' }
  }
  return { ok: true, name }
}

async function findRegistryLlm(
  configManager: ConfigManager,
  name: string,
): Promise<SavedRegistryLlm | undefined> {
  const config = await readConfigValues(configManager) as { registry?: { llms?: unknown[] } }
  const llms = Array.isArray(config.registry?.llms) ? config.registry.llms : []
  return llms.find((item) => {
    return Boolean(item)
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as { name?: unknown }).name === name
  }) as SavedRegistryLlm | undefined
}

type SavedRegistryLlm = { provider?: unknown; baseURL?: unknown; providerHeaders?: unknown }

const TEST_REDACTED = '[redacted]'
const MIN_REDACTED_HEADER_LENGTH = 4

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// 429-43: a saved model's header values are read from the file on the server, and only for the
// endpoint the saved model names; a read failure means no saved headers.
async function savedHeadersFor(
  configManager: ConfigManager | undefined,
  configName: string,
  provider: string,
  baseURL: string,
): Promise<Record<string, string>> {
  if (!configManager || !configName) return {}
  let saved: SavedRegistryLlm | undefined
  try {
    saved = await findRegistryLlm(configManager, configName)
  } catch {
    return {}
  }
  if (!saved || saved.provider !== provider || trimmedString(saved.baseURL) !== baseURL) return {}
  const headers = saved.providerHeaders
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') kept[name] = value
  }
  return kept
}

// Body headers override their saved namesake (HTTP names compare case-insensitively). The model row
// leaves out a header it showed as a marker, so the saved value is the one sent.
function mergeTestHeaders(
  saved: Record<string, string>,
  body: Record<string, unknown>,
): { headers: Record<string, unknown>; savedValues: string[] } {
  const headers: Record<string, unknown> = { ...saved }
  for (const [name, value] of Object.entries(body)) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
    }
    headers[name] = value
  }
  const savedValues = Object.entries(saved)
    .filter(([name, value]) => headers[name] === value)
    .map(([, value]) => value)
  return { headers, savedValues }
}

function withoutSavedValues(text: string, savedValues: readonly string[]): string {
  return [...savedValues]
    .filter((value) => value.length >= MIN_REDACTED_HEADER_LENGTH)
    .sort((a, b) => b.length - a.length)
    .reduce((redacted, value) => redacted.split(value).join(TEST_REDACTED), text)
}

// 441 GAP-D5: undefined when no declared mask is bound or it throws, so a caller leaves the text out.
function withDeclaredMask<T>(mask: MaskFn | undefined, build: (mask: MaskFn) => T): T | undefined {
  if (mask === undefined) return undefined
  try {
    return build(mask)
  } catch {
    return undefined
  }
}

// 441 GAP2-D5 (WR-G03): the target list answers masked names, so a save whose target holds one
// would write the marker into the file. A suite that does not parse is left to validation.
function suiteFileTarget(content: string): unknown {
  try {
    const parsed: unknown = parseYaml(content)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return (parsed as Record<string, unknown>).target
  } catch {
    return undefined
  }
}

function refusedShownMarkerTarget(res: ServerResponse, target: unknown): boolean {
  if (!holdsShownMarker(target)) return false
  json(res, {
    error: 'marker_written_back',
    message: MARKER_WRITTEN_BACK_SENTENCE,
    issues: [{ path: ['target'], message: MARKER_WRITTEN_BACK_SENTENCE }],
  }, 422)
  return true
}

// The product provider an auth.json entry belongs to, mapped the way GET /api/auth/status maps it.
function credentialProductProvider(key: string, credential: DashboardAuthCredential): string {
  if (credential.type === 'oauth') return toProductProviderLabel(credential.provider ?? key)
  if (credential.type === 'bearer') return credential.provider
  return credential.provider ?? key
}

function ownAuthEntry(
  store: Record<string, DashboardAuthCredential | undefined>,
  name: string,
): DashboardAuthCredential | undefined {
  return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : undefined
}

async function readAuthEntry(name: string): Promise<DashboardAuthCredential | undefined> {
  return ownAuthEntry(await readAuth() as Record<string, DashboardAuthCredential | undefined>, name)
}

const CREDENTIAL_PROVIDER_CONFLICT = {
  status: 409,
  error: 'credential_provider_conflict',
  message: 'A saved credential under this name belongs to a different provider.',
} as const

async function requireCredentialTarget(
  configManager: ConfigManager,
  name: string,
  provider: string,
): Promise<CredentialTarget> {
  const match = await findRegistryLlm(configManager, name)
  if (match && match.provider !== provider) {
    return { ok: false, status: 400, error: `LLM config "${name}" uses ${String(match.provider)}, not ${provider}` }
  }
  const existing = await readAuthEntry(name)
  if (existing && credentialProductProvider(name, existing) !== provider) {
    return { ok: false, ...CREDENTIAL_PROVIDER_CONFLICT }
  }
  return { ok: true, configName: name, created: existing === undefined }
}

async function requirePluginAuthConfig(
  configManager: ConfigManager | undefined,
  configName: unknown,
  plugin: LLMAuthProviderPlugin,
): Promise<CredentialTarget> {
  const name = checkCredentialName(configName)
  if (!name.ok) return name
  if (!configManager) {
    return { ok: false, status: 400, error: 'Config manager is required to save OAuth credentials' }
  }
  return requireCredentialTarget(configManager, name.name, plugin.providerId)
}

async function requireCredentialConfig(
  configManager: ConfigManager | undefined,
  configName: unknown,
  provider: string,
): Promise<CredentialTarget> {
  const name = checkCredentialName(configName)
  if (!name.ok) return name
  if (!API_KEY_CREDENTIAL_PROVIDERS.has(provider)) {
    return { ok: false, status: 400, error: 'provider must support typed credentials' }
  }
  if (!configManager) {
    return { ok: false, status: 400, error: 'Config manager is required to save credentials' }
  }
  return requireCredentialTarget(configManager, name.name, provider)
}

function credentialRefusalBody(refusal: { error: string; message?: string }): { error: string; message?: string } {
  return refusal.message === undefined ? { error: refusal.error } : { error: refusal.error, message: refusal.message }
}

async function credentialConflictAt(name: string, provider: string): Promise<boolean> {
  const existing = await readAuthEntry(name)
  return existing !== undefined && credentialProductProvider(name, existing) !== provider
}

export type CredentialLock = <T>(work: () => Promise<T>) => Promise<T>

// 429-09: one queue per router for every auth.json write and removal, so a save, a move, a delete
// and a sign-in completion never interleave their read-modify-write of the machine-wide store.
export function createCredentialLock(): CredentialLock {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work)
    tail = run.catch(() => undefined)
    return run
  }
}

type DashboardAuthCredential =
  | { type: 'oauth'; provider?: string; tokens: { expires: number } }
  | { type: 'api'; provider?: string; key?: string }
  | { type: 'bearer'; provider: string; token?: string }

interface DashboardLLMProviderMetadata {
  id: string
  label: string
  auth:
    | { kind: 'api-key'; credentialTypes: Array<'api-key' | 'bearer-token'>; optional?: boolean }
    | { kind: 'oauth-plugin'; mode: 'browser-poll' | 'manual-code'; buttonLabel?: string }
  modelAdapter?: 'openai-responses' | 'anthropic-messages'
  needsBaseURL?: boolean
  authModes?: Array<'api-key' | 'bearer-token' | 'subscription' | 'none'>
  subscription?: boolean
  baseURLPlaceholder?: string
  defaultModel?: string
}

interface PluginOAuthSession {
  providerId: string
  credentialProviderId: string
  configName: string
  sessionState?: unknown
  cleanup?: () => void
  status: 'pending' | 'completed' | 'error'
  expiresAt: number
  error?: string
}

function serializeProviderDescriptor(descriptor: ProviderDescriptor): DashboardLLMProviderMetadata {
  return {
    id: descriptor.id,
    label: descriptor.label,
    auth: {
      kind: 'api-key',
      credentialTypes: descriptor.authModes.filter(
        mode => mode === 'api-key' || mode === 'bearer-token',
      ),
      ...(descriptor.credentialOptional ? { optional: true } : {}),
    },
    ...(descriptor.modelAdapter ? { modelAdapter: descriptor.modelAdapter } : {}),
    needsBaseURL: descriptor.needsBaseURL,
    authModes: descriptor.authModes,
    ...(descriptor.subscription ? { subscription: true } : {}),
    ...(descriptor.baseURLPlaceholder ? { baseURLPlaceholder: descriptor.baseURLPlaceholder } : {}),
    ...(descriptor.defaultModel ? { defaultModel: descriptor.defaultModel } : {}),
  }
}

function builtinLLMProviderMetadata(): DashboardLLMProviderMetadata[] {
  return listProviders()
    .filter(descriptor => !descriptor.subscription)
    .map(serializeProviderDescriptor)
}

function serializeAuthProviderPlugin(plugin: LLMAuthProviderPlugin): DashboardLLMProviderMetadata {
  return {
    id: plugin.providerId,
    label: plugin.label,
    modelAdapter: plugin.modelAdapter,
    auth: {
      kind: 'oauth-plugin',
      mode: plugin.dashboardAuth.mode,
      ...(plugin.dashboardAuth.buttonLabel ? { buttonLabel: plugin.dashboardAuth.buttonLabel } : {}),
    },
  }
}

type DashboardRuntimeLLMConfig = DashboardLLMConfig & {
  vision?: DashboardVisionConfig
  modelVision?: boolean
}

type DashboardVisionConfig = {
  screenshotSize?: number
  effectiveResolution?: number
}

const writeDashboardAuth = writeAuth as unknown as (
  provider: string,
  credential: DashboardAuthCredential,
) => Promise<void>

type DashboardResolvedRuntimeLLM =
  | { ok: true; llmConfig: DashboardRuntimeLLMConfig; authFetch?: typeof globalThis.fetch }
  | { ok: false; error: string }

function normalizeRuntimeLLMConfig(raw: unknown): { configName: string; config: DashboardRuntimeLLMConfig } | undefined {
  if (!isPlainRecord(raw)) return undefined
  if (typeof raw.name !== 'string' || !raw.name.trim()) return undefined
  if (typeof raw.provider !== 'string' || !raw.provider.trim()) return undefined
  if (typeof raw.model !== 'string' || !raw.model.trim()) return undefined

  const config: DashboardRuntimeLLMConfig = {
    provider: raw.provider,
    model: raw.model,
  }
  if (typeof raw.baseURL === 'string') config.baseURL = raw.baseURL
  if (isPlainRecord(raw.providerHeaders)) {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.providerHeaders)) {
      if (typeof value === 'string') headers[key] = value
    }
    config.providerHeaders = headers
  }
  if (typeof raw.vision === 'boolean') config.modelVision = raw.vision

  return { configName: raw.name, config }
}

function normalizeDashboardVisionConfig(raw: unknown): DashboardVisionConfig | undefined {
  if (!isPlainRecord(raw)) return undefined
  const config: DashboardVisionConfig = {}
  if (typeof raw.screenshotSize === 'number') {
    config.screenshotSize = raw.screenshotSize
  } else if (typeof raw.screenshotSize === 'string') {
    const parsedSize = SizeString.safeParse(raw.screenshotSize)
    if (parsedSize.success) config.screenshotSize = parsedSize.data
  }
  if (typeof raw.effectiveResolution === 'number' && Number.isInteger(raw.effectiveResolution) && raw.effectiveResolution > 0) {
    config.effectiveResolution = raw.effectiveResolution
  }
  return config.screenshotSize !== undefined || config.effectiveResolution !== undefined ? config : undefined
}

async function resolveDashboardRuntimeLLM(
  configManager: ConfigManager | undefined,
  fallbackLLMConfig: DashboardRuntimeLLMConfig | undefined,
  fallbackAuthFetch: typeof globalThis.fetch | undefined,
): Promise<DashboardResolvedRuntimeLLM> {
  if (!configManager) {
    if (!fallbackLLMConfig) {
      return { ok: false, error: 'LLM not configured. Set up LLM provider in settings.' }
    }
    return { ok: true, llmConfig: fallbackLLMConfig, authFetch: fallbackAuthFetch }
  }

  const rawConfig = await readConfigValues(configManager)
  const registry = isPlainRecord(rawConfig.registry) ? rawConfig.registry : {}
  const use = isPlainRecord(rawConfig.use) ? rawConfig.use : {}
  const llms = Array.isArray(registry.llms) ? registry.llms : []
  const selectedName = typeof use.llm === 'string' ? use.llm : undefined
  const selected = selectedName
    ? llms.find((candidate) => isPlainRecord(candidate) && candidate.name === selectedName)
    : llms[0]

  const normalized = normalizeRuntimeLLMConfig(selected)
  if (!normalized) {
    if (!fallbackLLMConfig) {
      return { ok: false, error: 'LLM not configured. Set up LLM provider in settings.' }
    }
    return { ok: true, llmConfig: fallbackLLMConfig, authFetch: fallbackAuthFetch }
  }

  const coreAuth = await import('@vostride/agent-qa-core') as typeof import('@vostride/agent-qa-core') & {
    resolveLLMAuth: (
      configName: string,
      config: DashboardRuntimeLLMConfig,
    ) => Promise<
      | { kind: 'api-key'; apiKey: string }
      | { kind: 'bearer-token'; token: string }
      | { kind: 'auth-fetch'; fetch: typeof globalThis.fetch; modelAdapter: 'openai-responses' | 'anthropic-messages' }
      | { kind: 'unauthenticated'; message: string }
      | { kind: 'missing'; message: string }
    >
  }
  const auth = await coreAuth.resolveLLMAuth(normalized.configName, normalized.config)
  if (auth.kind === 'missing') {
    return { ok: false, error: auth.message }
  }

  const servicesVision = isPlainRecord(rawConfig.services)
    ? normalizeDashboardVisionConfig(rawConfig.services.vision)
    : undefined
  const runtimeConfig: DashboardRuntimeLLMConfig = {
    ...normalized.config,
    vision: resolveVisionConfig(servicesVision),
  }
  let resolvedAuthFetch: typeof globalThis.fetch | undefined
  if (auth.kind === 'api-key') {
    runtimeConfig.apiKey = auth.apiKey
  } else if (auth.kind === 'bearer-token') {
    runtimeConfig.authToken = auth.token
  } else if (auth.kind === 'auth-fetch') {
    runtimeConfig.modelAdapter = auth.modelAdapter
    resolvedAuthFetch = auth.fetch
  }

  return { ok: true, llmConfig: runtimeConfig, authFetch: resolvedAuthFetch }
}

function cleanupPluginOAuthSession(session: PluginOAuthSession): void {
  const cleanup = session.cleanup
  session.cleanup = undefined
  if (!cleanup) return
  try {
    cleanup()
  } catch {
    // Best-effort cleanup for plugin-owned local callback servers.
  }
}

function pruneExpiredPluginOAuthSessions(sessions: Map<string, PluginOAuthSession>, now = Date.now()): void {
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= now) {
      cleanupPluginOAuthSession(session)
      sessions.delete(sessionId)
    }
  }
}

function isLocalLLMBaseURL(baseURL: unknown): boolean {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return false
  try {
    const url = new URL(baseURL)
    const hostname = url.hostname.toLowerCase()
    return hostname === 'localhost'
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || hostname === '[::1]'
      || hostname.startsWith('127.')
      || hostname.endsWith('.local')
  } catch {
    return false
  }
}

function llmConnectionTestTimeoutMs(config: { provider?: unknown; baseURL?: unknown }): number {
  // Connectivity probes are config-screen smoke checks only; real run execution
  // uses configured test timeout metadata and does not read this value.
  if (LOCAL_COMPATIBLE_LLM_PROVIDERS.has(String(config.provider)) && isLocalLLMBaseURL(config.baseURL)) {
    return LOCAL_COMPATIBLE_LLM_CONNECTION_TEST_TIMEOUT_MS
  }
  return REMOTE_LLM_CONNECTION_TEST_TIMEOUT_MS
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

/**
 * An answer that carries NO cross-origin read grant.
 *
 * ADDITIVE, and `json()` above is untouched on purpose: its wildcard posture serves the legacy
 * read routes and re-platforming those is Phase 402's question, not this one's. What this writer
 * exists for is the narrow class of answers that hand out a CAPABILITY. `Access-Control-Allow-Origin: *`
 * on such an answer means a document on any origin may READ the token out of the response — the
 * refusal beside it would be worthless if the body were still readable through a redirect or a
 * misconfigured proxy. No wildcard, no allow-methods: the dashboard's own page is same-origin and
 * needs neither, and every non-browser client ignores both.
 */
function jsonNoCors(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

/**
 * Refuse a cross-site driver on a run-text read, and refuse it with NO cross-origin grant on the
 * refusal either.
 *
 * WHY THESE ARMS AND NOT THE OTHERS (405 CR-01). They answer a run's stored text, served as it
 * was stored (441 D-07), and they keep the no-grant posture CR-01 gave them.
 *
 * WHY THE REFUSAL AND NOT ONLY THE MISSING HEADER. Dropping the wildcard stops a page on another
 * ORIGIN from READING the body. It does not stop DNS rebinding, where the attacker's own name
 * resolves to a loopback address and the browser therefore treats the read as same-origin and asks
 * for no grant at all. `refuseCrossSiteRequest` carries the Host check that closes that, and it
 * ADMITS the caller that sends no `Origin` — the CLI, `curl`, the conformance harness — which is
 * the local drive these arms exist for.
 *
 * SCOPE, DELIBERATELY NARROW. Only the run-text arms. `json()` above keeps its wildcard
 * for the legacy read routes, whose whole-server posture is the re-platform question its own
 * docstring defers; widening it here would change the posture of routes this fix does not own.
 *
 * THE SHARED PREFLIGHT ARM IS LEFT ALONE, and that is a decision rather than an oversight. `cors()`
 * still answers every OPTIONS with the wildcard. All four arms here are SIMPLE GETs, so a browser
 * needs no preflight to send them and a preflight grant confers no read; what confers the read is
 * the grant on the ACTUAL response, and that is the one removed. A preflighted variant now gets a
 * permissive OPTIONS followed by a response the browser refuses to hand to the page — it fails
 * closed. Excluding these paths from `cors()` would mean claiming the `/api/runs/` prefix ahead of
 * the shared arm the way the run-confirm prefix used to claim its own (deleted in 432-14), which
 * would capture the trigger, cancel, delete, live-url, detail and post-processing routes too: the
 * whole-server posture change this fix is deliberately not making.
 */
function refuseCrossSiteDisplayRead(req: IncomingMessage, res: ServerResponse): boolean {
  if (refuseCrossSiteRequest(req) === undefined) return false
  jsonNoCors(res, { error: 'cross_site_refused' }, 403)
  return true
}

const INSIGHTS_KNOWLEDGE_RUN_CAP = 200
const INSIGHTS_KNOWLEDGE_CONCURRENCY = 4

type KnowledgeChangeKind = (typeof RecordChangeSchema.shape.change.options)[number]

interface InsightsKnowledgeChanges {
  status: 'read'
  /** The window's settled runs: started, and neither queued nor running. */
  runsInWindow: number
  runsRead: number
  runsUnreadable: number
  runsCurationFailed: number
  runsCurationUnfinished: number
  /** The window's runs still queued or running; they are not read. */
  runsInFlight: number
  truncated?: { read: number; total: number }
  byKind: Record<KnowledgeChangeKind, number>
}

type InsightsRunCuration = 'read' | 'unreadable' | 'failed' | 'unfinished'

/**
 * `pending` is ambiguous: the chain may be queued, or it was never enqueued because the run was
 * skipped by design (a gate run, an excluded outcome). Only the post-processing read can tell,
 * and only its `skipped` fact is used.
 */
async function isPostProcessingSkipped(host: AgentHost, runId: string): Promise<boolean> {
  const parsed = RunsPostProcessingInputSchema.safeParse({ runId })
  if (!parsed.success) return false
  try {
    const status = await host.invokeFunction(
      host.registry,
      host.runsPostProcessingFunctionId,
      parsed.data,
      host.caller,
    ) as PostProcessingStatus
    return status?.skipped !== undefined
  } catch {
    return false
  }
}

/**
 * Tally the window's knowledge changes by kind, one `runs.knowledge` read per settled run
 * (433-30, 433-42).
 *
 * A run is read only when its curation finished (`complete`), or when its curation reads `pending`
 * because the run's post-processing was skipped by design, so there was nothing to curate.
 * Only read runs' changes are counted. Every other run is counted apart and never as a run that
 * changed nothing:
 * - unreadable: the read was refused or threw, the handoff is gone (`evidence-incomplete`), or the
 *   store scan behind its changes was incomplete;
 * - curation failed: `failed`;
 * - curation unfinished: `running`, or `pending` with no skipped fact (or an unreadable one).
 * Runs still queued or running are not read at all; they are counted as in flight. The latest
 * {@link INSIGHTS_KNOWLEDGE_RUN_CAP} settled runs are read; a larger window says so.
 */
async function readInsightsKnowledgeChanges(
  host: AgentHost,
  db: DashboardDatabase,
  window: { from?: string; to?: string },
): Promise<InsightsKnowledgeChanges> {
  const { runIds, total, inFlight } = db.listInsightsWindowRunIds({ ...window, limit: INSIGHTS_KNOWLEDGE_RUN_CAP })
  const byKind = Object.fromEntries(
    RecordChangeSchema.shape.change.options.map((kind) => [kind, 0]),
  ) as Record<KnowledgeChangeKind, number>
  const tally: Record<InsightsRunCuration, number> = { read: 0, unreadable: 0, failed: 0, unfinished: 0 }
  const classify = async (runId: string): Promise<InsightsRunCuration> => {
    const outcome = await readRunKnowledge(host, runId).catch(() => undefined)
    if (outcome?.kind !== 'ok' || outcome.body.kind !== 'ready' || outcome.body.learned.scanIncomplete) {
      return 'unreadable'
    }
    const curation = outcome.body.curation.status
    let state: InsightsRunCuration
    if (curation === 'complete') state = 'read'
    else if (curation === 'failed') state = 'failed'
    else if (curation === 'pending' && await isPostProcessingSkipped(host, runId)) state = 'read'
    else state = 'unfinished'
    if (state === 'read') {
      for (const change of outcome.body.learned.changes) {
        if (Object.hasOwn(byKind, change.change)) byKind[change.change] += 1
      }
    }
    return state
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < runIds.length) {
      tally[await classify(runIds[next++])] += 1
    }
  }
  await Promise.all(Array.from({ length: Math.min(INSIGHTS_KNOWLEDGE_CONCURRENCY, runIds.length) }, worker))
  return {
    status: 'read',
    runsInWindow: total,
    runsRead: tally.read,
    runsUnreadable: tally.unreadable,
    runsCurationFailed: tally.failed,
    runsCurationUnfinished: tally.unfinished,
    runsInFlight: inFlight,
    ...(total > runIds.length ? { truncated: { read: runIds.length, total } } : {}),
    byKind,
  }
}

function notFound(res: ServerResponse, message = 'Not found'): void {
  json(res, { error: message }, 404)
}

function cors(res: ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getConfiguredAuthStateDir(config: Record<string, unknown>): string | undefined {
  const services = isPlainRecord(config.services) ? config.services : undefined
  const authState = services && isPlainRecord(services.authState) ? services.authState : undefined
  return typeof authState?.dir === 'string' ? authState.dir : undefined
}

function getSessionTargetNameForAuthState(session: { getState?: () => unknown } | undefined): string {
  if (!session || typeof session.getState !== 'function') return 'selected target'
  try {
    const state = session.getState()
    if (isPlainRecord(state) && typeof state.targetName === 'string' && state.targetName.trim().length > 0) {
      return state.targetName.trim()
    }
  } catch {
    // Do not let state serialization failures leak into auth-state responses.
  }
  return 'selected target'
}

function buildAuthStateSaveErrorMessage(
  stateName: string,
  targetName: string,
  error: unknown,
): { status: number; message: string } {
  const raw = error instanceof Error ? error.message : String(error)
  if (/already exists/i.test(raw)) {
    return {
      status: 409,
      message: `Auth state "${stateName}" for target "${targetName}" already exists. Use replace=true to replace it.`,
    }
  }

  if (/web Live Mode|not ready|executing|busy/i.test(raw)) {
    return {
      status: 409,
      message: `Could not save auth state "${stateName}" for target "${targetName}".`,
    }
  }

  return {
    status: 500,
    message: `Could not save auth state "${stateName}" for target "${targetName}".`,
  }
}

// 2026-08-27 (405-07, D-14): a containment predicate and a plain-filename predicate stood here.
// Both existed for the deleted path-serving routes and the deleted run-deletion sweep, which were
// their only callers. The containment rule for artifact bytes is the evidence store's own now,
// reached through the `runs.artifact` op — one rule, in the place that owns the layout.

function createHookRegistryManager(configManager?: ConfigManager, configPath?: string): HookRegistryManager | null {
  if (!configManager || !configPath) {
    return null
  }
  return new HookRegistryManager(configManager, configPath)
}

function normalizeRunFilterValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

function buildRunRequestAttributes(input: {
  trigger: 'dashboard' | 'api' | 'mcp'
  userAttributes?: unknown
}): RunAttributes {
  const internal = buildInternalRunAttributes({
    trigger: input.trigger,
    runner: 'local',
  })
  const user = validateUserRunAttributes(input.userAttributes, 'run attributes')
  return mergeRunAttributes(internal, user)
}

function parseDashboardRunTriggerSource(value: unknown): { ok: true; trigger: 'dashboard' | 'mcp' } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, trigger: 'dashboard' }
  if (value === 'dashboard' || value === 'mcp') return { ok: true, trigger: value }
  return { ok: false, error: 'triggerSource must be one of: dashboard, mcp' }
}

function parseAttributePredicates(searchParams: URLSearchParams): { ok: true; predicates: AttributePredicate[] } | { ok: false; error: string } {
  const predicates = new Map<string, AttributePredicate>()
  for (const [paramKey, value] of searchParams.entries()) {
    const match = /^attributes\[([^\]]*)\](?:\[(regex)\])?$/.exec(paramKey)
    if (!match) continue
    const key = match[1]
    const mode = match[2] === 'regex' ? 'regex' : 'exact'
    if (!key.trim()) return { ok: false, error: 'Attribute key must be non-empty' }
    if (!value.trim()) return { ok: false, error: 'Attribute value must be non-empty' }
    const existing = predicates.get(key)
    if (existing && existing.mode !== mode) {
      return { ok: false, error: `Cannot combine exact and regex attribute filters for "${key}"` }
    }
    if (mode === 'regex') {
      try {
        new RegExp(value)
      } catch {
        return { ok: false, error: `Invalid attribute regex for "${key}"` }
      }
    }
    predicates.set(key, { key, value, mode })
  }
  return { ok: true, predicates: [...predicates.values()] }
}

function parseAnalyticsScopePredicates(config: Record<string, unknown> | undefined): { ok: true; predicates: AttributePredicate[] } | { ok: false; error: string } {
  const analytics = config?.analytics
  if (!analytics || typeof analytics !== 'object' || Array.isArray(analytics)) return { ok: true, predicates: [] }
  const passRateScope = (analytics as Record<string, unknown>).passRateScope
  if (!passRateScope || typeof passRateScope !== 'object' || Array.isArray(passRateScope)) return { ok: true, predicates: [] }
  const attributes = (passRateScope as Record<string, unknown>).attributes
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return { ok: true, predicates: [] }

  const predicates: AttributePredicate[] = []
  for (const [key, rawValue] of Object.entries(attributes)) {
    if (!key.trim()) return { ok: false, error: 'analytics.passRateScope attribute key must be non-empty' }
    if (typeof rawValue === 'string') {
      if (!rawValue.trim()) return { ok: false, error: `analytics.passRateScope attribute "${key}" must be non-empty` }
      predicates.push({ key, value: rawValue, mode: 'exact' })
      continue
    }
    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && typeof (rawValue as { regex?: unknown }).regex === 'string') {
      const regex = (rawValue as { regex: string }).regex
      if (!regex.trim()) return { ok: false, error: `analytics.passRateScope attribute "${key}" regex must be non-empty` }
      try {
        new RegExp(regex)
      } catch {
        return { ok: false, error: `Invalid analytics.passRateScope regex for "${key}"` }
      }
      predicates.push({ key, value: regex, mode: 'regex' })
    }
  }
  return { ok: true, predicates }
}

async function readAnalyticsScopePredicates(configManager: ConfigManager | undefined): Promise<{ ok: true; predicates: AttributePredicate[] } | { ok: false; error: string }> {
  if (!configManager) return { ok: true, predicates: [] }
  const config = await readConfigValues(configManager)
  const parsedConfig = AgentQaConfigSchema.safeParse(config)
  if (!parsedConfig.success) {
    return { ok: true, predicates: [] }
  }
  return parseAnalyticsScopePredicates(parsedConfig.data as Record<string, unknown>)
}

function calculateFlakyMetrics(classes: ReadonlyArray<RunStatusClass | 'skipped' | undefined>): { score: number; statusCount: number } {
  const statuses = classes.filter(c => c === 'pass' || c === 'fail')
  let alternations = 0
  for (let i = 1; i < statuses.length; i++) {
    if (statuses[i] !== statuses[i - 1]) alternations++
  }
  return {
    score: statuses.length > 1 ? alternations / (statuses.length - 1) : 0,
    statusCount: statuses.length,
  }
}

// 2026-10-18 (444-31, D-64): a list row's rate is its viewer's own fold; passed and decided are
// that fold's pass and pass-or-fail counts.
function passRateOf(trends: {
  passRate: number | null
  daily: ReadonlyArray<{ passed: number; failed: number }>
}): { passRate: number | null; passed: number; decided: number } {
  return {
    passRate: trends.passRate,
    passed: trends.daily.reduce((sum, day) => sum + day.passed, 0),
    decided: trends.daily.reduce((sum, day) => sum + day.passed + day.failed, 0),
  }
}

function lastRunOf(run: RunRow | undefined): {
  id: string
  status: string
  startedAt: string | null
  createdAt: string
  duration: number
} | null {
  if (!run) return null
  return { id: run.id, status: run.status, startedAt: run.startedAt, createdAt: run.createdAt, duration: run.duration }
}

function normalizeSupportedPlatform(value: unknown): SupportedPlatform | null {
  if (value !== 'web' && value !== 'android' && value !== 'ios') return null
  return value
}

function parseIsoDateQueryParam(
  value: string | null,
  field: 'from' | 'to',
): { ok: true; value?: string } | { ok: false; error: string } {
  if (!value) return { ok: true, value: undefined }
  return Number.isNaN(Date.parse(value))
    ? { ok: false, error: `${field} must be a valid ISO date` }
    : { ok: true, value }
}

function parseBoundedIntegerQueryParam(
  value: string | null,
  field: string,
  min: number,
  max: number,
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!value) return { ok: true, value: fallback }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `${field} must be an integer` }
  }
  return { ok: true, value: Math.min(max, Math.max(min, parsed)) }
}

function getTargetPlatformMap(config: unknown): Map<string, SupportedPlatform> {
  const targetsValue = (config as {
    registry?: { targets?: Record<string, { platform?: unknown }> }
  }).registry?.targets

  const targetPlatforms = new Map<string, SupportedPlatform>()
  if (!targetsValue || typeof targetsValue !== 'object') return targetPlatforms

  for (const [targetName, targetConfig] of Object.entries(targetsValue)) {
    const platform = normalizeSupportedPlatform(targetConfig?.platform)
    if (platform) targetPlatforms.set(targetName, platform)
  }

  return targetPlatforms
}

async function readTargetPlatformMap(configManager?: ConfigManager): Promise<Map<string, SupportedPlatform>> {
  if (!configManager) return new Map()
  try {
    const config = await readConfigValues(configManager)
    return getTargetPlatformMap(config)
  } catch {
    return new Map()
  }
}

function parseTimeoutConfigTestTimeoutMs(timeoutConfig: unknown): number | undefined {
  if (timeoutConfig && typeof timeoutConfig === 'object' && !Array.isArray(timeoutConfig)) {
    const transformedTimeout = (timeoutConfig as { test?: unknown }).test
    if (typeof transformedTimeout === 'number' && Number.isFinite(transformedTimeout) && transformedTimeout > 0) {
      return transformedTimeout
    }
  }
  const parsed = TimeoutConfigSchema.partial().safeParse(timeoutConfig)
  if (!parsed.success) return undefined
  const testTimeout = parsed.data.test
  return typeof testTimeout === 'number' && Number.isFinite(testTimeout) && testTimeout > 0
    ? testTimeout
    : undefined
}

function parseUseTestTimeoutMs(useConfig: unknown): number | undefined {
  if (!useConfig || typeof useConfig !== 'object' || Array.isArray(useConfig)) return undefined
  return parseTimeoutConfigTestTimeoutMs((useConfig as { timeout?: unknown }).timeout)
}

async function readConfigTestTimeoutMs(configManager?: ConfigManager): Promise<number | undefined> {
  if (!configManager) return undefined
  try {
    const config = await readConfigValues(configManager)
    const parsed = AgentQaConfigSchema.safeParse(config)
    if (parsed.success) {
      return parseUseTestTimeoutMs(parsed.data.use)
    }
    return parseUseTestTimeoutMs((config as { use?: unknown }).use)
  } catch {
    return undefined
  }
}

function readTestYamlTimeoutMs(content: string): number | undefined {
  try {
    const parsedYaml = parseYaml(content)
    const parsedTest = TestDefinitionSchema.safeParse(parsedYaml)
    if (parsedTest.success) {
      return parseUseTestTimeoutMs(parsedTest.data.use)
    }
    return parseUseTestTimeoutMs((parsedYaml as { use?: unknown } | null | undefined)?.use)
  } catch {
    return undefined
  }
}

function readSuiteYamlTimeoutMs(content: string): number | undefined {
  try {
    const parsedYaml = parseYaml(content)
    const parsedSuite = SuiteDefinitionSchema.safeParse(parsedYaml)
    if (parsedSuite.success) {
      return parseUseTestTimeoutMs(parsedSuite.data.use)
    }
    return parseUseTestTimeoutMs((parsedYaml as { use?: unknown } | null | undefined)?.use)
  } catch {
    return undefined
  }
}

function parseUseParallel(useConfig: unknown): boolean | undefined {
  if (!isRecord(useConfig)) return undefined
  return typeof useConfig.parallel === 'boolean' ? useConfig.parallel : undefined
}

async function readConfigUseParallel(configManager?: ConfigManager): Promise<boolean | undefined> {
  if (!configManager) return undefined
  try {
    const config = await readConfigValues(configManager)
    const parsed = AgentQaConfigSchema.safeParse(config)
    if (parsed.success) {
      return parseUseParallel(parsed.data.use)
    }
    return parseUseParallel((config as { use?: unknown }).use)
  } catch {
    return undefined
  }
}

function readSuiteYamlParallel(content: string): boolean | undefined {
  try {
    const parsedYaml = parseYaml(content)
    const parsedSuite = SuiteDefinitionSchema.safeParse(parsedYaml)
    if (parsedSuite.success) {
      return parseUseParallel(parsedSuite.data.use)
    }
    return parseUseParallel((parsedYaml as { use?: unknown } | null | undefined)?.use)
  } catch {
    return undefined
  }
}

function withDashboardExecutionBuffer(
  baseTimeoutMs: number | undefined,
  source: DashboardExecutionTimeoutSource,
): DashboardExecutionTimeout {
  if (!baseTimeoutMs) {
    return { source: 'none' }
  }
  return {
    timeoutMs: baseTimeoutMs + DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS,
    source,
    baseTimeoutMs,
    bufferMs: DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS,
  }
}

async function resolveDashboardExecutionTimeout(opts: {
  isSuite: boolean
  file?: string
  normalizedTestPath?: string
  testFileManager?: TestFileManager
  suiteFileManager?: SuiteFileManager
  configManager?: ConfigManager
}): Promise<DashboardExecutionTimeout> {
  if (opts.file) {
    if (opts.isSuite && opts.suiteFileManager) {
      try {
        const suiteContent = await opts.suiteFileManager.read(opts.file)
        const suiteTimeout = readSuiteYamlTimeoutMs(suiteContent)
        if (suiteTimeout) {
          return withDashboardExecutionBuffer(suiteTimeout, 'suite.use.timeout.test')
        }
      } catch {
        // Fall through to config timeout for draft or unreadable suite files.
      }
    } else if (!opts.isSuite && opts.testFileManager) {
      try {
        const testContent = await opts.testFileManager.read(opts.normalizedTestPath ?? opts.file)
        const testTimeout = readTestYamlTimeoutMs(testContent)
        if (testTimeout) {
          return withDashboardExecutionBuffer(testTimeout, 'test.use.timeout.test')
        }
      } catch {
        // Fall through to config timeout for draft or unreadable test files.
      }
    }
  }

  const configTimeout = await readConfigTestTimeoutMs(opts.configManager)
  return withDashboardExecutionBuffer(configTimeout, configTimeout ? 'config.use.timeout.test' : 'none')
}

function toExecutionTimeoutMetadata(timeout: DashboardExecutionTimeout): Record<string, unknown> {
  if (!timeout.timeoutMs) {
    return { timeoutSource: timeout.source }
  }
  return {
    timeout: timeout.timeoutMs,
    timeoutSource: timeout.source,
    timeoutBaseMs: timeout.baseTimeoutMs,
    timeoutBufferMs: timeout.bufferMs,
  }
}

function resolveEffectivePlatform(
  platform: string | null | undefined,
  targetName: string | null | undefined,
  targetPlatforms: Map<string, SupportedPlatform>,
  fallbackPlatform?: string | null,
): SupportedPlatform | null {
  const explicitPlatform = normalizeSupportedPlatform(platform)
  if (explicitPlatform) return explicitPlatform

  if (targetName) {
    const targetPlatform = targetPlatforms.get(targetName)
    if (targetPlatform) return targetPlatform
  }

  return normalizeSupportedPlatform(fallbackPlatform)
}

function extractRunTargetName(testFileContent: string | null | undefined): string | null {
  if (!testFileContent) return null
  return extractTestFileMetadata(testFileContent).targetName
}

type EnrichedRunRow = RunRow & {
  targetName: string | null
  tests?: EnrichedRunRow[]
}

function enrichRunRow(
  run: RunRow,
  targetPlatforms: Map<string, SupportedPlatform>,
  tests?: EnrichedRunRow[],
): EnrichedRunRow {
  const metadata = run.testFileContent ? extractTestFileMetadata(run.testFileContent) : null
  let targetName = metadata?.targetName ?? extractRunTargetName(run.testFileContent)
  if (!targetName && tests && tests.length > 0) {
    const uniqueChildTargets = [...new Set(
      tests
        .map((test) => test.targetName)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    )]
    if (uniqueChildTargets.length === 1) {
      targetName = uniqueChildTargets[0]
    }
  }

  const uniqueChildPlatforms = tests
    ? [...new Set(
        tests
          .map((test) => normalizeSupportedPlatform(test.platform))
          .filter((value): value is SupportedPlatform => value !== null),
      )]
    : []

  const platform = resolveEffectivePlatform(
    metadata?.platform,
    targetName,
    targetPlatforms,
    uniqueChildPlatforms.length === 1 ? uniqueChildPlatforms[0] : run.platform,
  )

  return {
    ...run,
    platform: platform ?? run.platform,
    targetName,
    ...(tests ? { tests } : {}),
  }
}

// 2026-10-18 (444-31, D-64): a suite row's target and platform come from its own history, newest
// first: the newest run with a target names both, else its last run does.
function suiteTargetOf(
  runs: readonly RunRow[],
  targetPlatforms: Map<string, SupportedPlatform>,
): { platform: string | null; targetName: string | null } {
  let last: EnrichedRunRow | undefined
  for (const run of runs) {
    const enriched = enrichRunRow(run, targetPlatforms)
    last ??= enriched
    const targetName = enriched.targetName?.trim()
    if (targetName) return { platform: enriched.platform, targetName }
  }
  if (!last) return { platform: null, targetName: null }
  return { platform: last.platform, targetName: last.targetName?.trim() || null }
}

function matchesTargetFilter(run: EnrichedRunRow, filterValue: string | null): boolean {
  if (!filterValue) return true
  if (normalizeRunFilterValue(run.targetName) === filterValue) return true
  return run.tests?.some((test) => normalizeRunFilterValue(test.targetName) === filterValue) ?? false
}

function matchesPlatformFilter(run: EnrichedRunRow, filterValue: SupportedPlatform | null): boolean {
  if (!filterValue) return true
  if (normalizeSupportedPlatform(run.platform) === filterValue) return true
  return run.tests?.some((test) => normalizeSupportedPlatform(test.platform) === filterValue) ?? false
}

function getArtifactMissingSections(artifact: RunArtifactRow | null): string[] {
  if (!artifact) return ['artifact']
  const missing: string[] = []
  const payload = artifact.payload
  if (!('config' in payload)) missing.push('config')
  if (!('source' in payload)) missing.push('source')
  return missing
}

const SECRET_TEMPLATE_RE = /\{\{secret:(\w+)\}\}/g

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeSecretTemplates(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(SECRET_TEMPLATE_RE, (_match, name: string) => `[secret:${name}]`)
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecretTemplates(item))
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeSecretTemplates(item)]),
    )
  }
  return value
}

function sanitizeSecretsFileMetadata(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (!isRecord(value)) return value
  return {
    path: typeof value.path === 'string' || value.path === null ? value.path : null,
    status: typeof value.status === 'string' ? value.status : 'loaded',
    ...(typeof value.count === 'number' ? { count: value.count } : {}),
  }
}

function sanitizeArtifactPayloadForResponse(payload: RunArtifactRow['payload']): RunArtifactRow['payload'] {
  const sanitized = sanitizeSecretTemplates(payload)
  if (!isRecord(sanitized)) return payload
  // G-401-18-CR01: the SEVENTH door. `JobQueue.enqueue` writes the caller's `metadata` object into
  // `run_artifacts.payload.metadata` as well as `runs.metadata`, and this response is what serves
  // it. The strip is the SAME allowlist the run rows go through — see `sanitizeRunMetadataForResponse`.
  const withSafeMetadata = sanitizeArtifactPayloadMetadata(sanitized)
  const config = withSafeMetadata.config
  if (!isRecord(config) || !('secretsFile' in config)) return withSafeMetadata as unknown as RunArtifactRow['payload']
  return {
    ...withSafeMetadata,
    config: {
      ...config,
      secretsFile: sanitizeSecretsFileMetadata(config.secretsFile),
    },
  } as RunArtifactRow['payload']
}

function sanitizeArtifactForResponse(artifact: RunArtifactRow | null): RunArtifactRow | null {
  if (!artifact) return null
  return {
    ...artifact,
    payload: sanitizeArtifactPayloadForResponse(artifact.payload),
  }
}

async function normalizeDashboardWorkspacePath(
  filePath: string,
  workspacePaths: ResolvedWorkspacePaths | undefined,
  kind: WorkspaceFileKind,
  requireExisting = true,
): Promise<{ storagePath: string; executionPath: string }> {
  if (!workspacePaths) {
    throw new Error('Workspace path resolution is required for dashboard-triggered runs')
  }

  const record = await resolveWorkspaceFileTarget({
    workspace: workspacePaths,
    kind,
    filePath,
    requireExisting,
  })

  return { storagePath: record.workspaceRelativePath, executionPath: record.absolutePath }
}

function workspaceRecordToPath(record: WorkspaceFileRecord): { storagePath: string; executionPath: string } {
  return { storagePath: record.workspaceRelativePath, executionPath: record.absolutePath }
}

async function resolveDashboardTestPattern(
  pattern: string,
  workspacePaths: ResolvedWorkspacePaths | undefined,
): Promise<Array<{ storagePath: string; executionPath: string }>> {
  if (!workspacePaths) {
    throw new Error('Workspace path resolution is required for dashboard-triggered runs')
  }

  const normalizedPattern = pattern.replace(/\\/g, '/')
  if (isAbsolute(pattern) || normalizedPattern.split('/').includes('..')) {
    throw new Error(`Workspace test pattern is not allowed: ${pattern}`)
  }

  const candidates = await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'test' })
  const patternWorkspace: ResolvedWorkspacePaths = {
    ...workspacePaths,
    testMatch: [pattern],
    suiteMatch: [],
  }
  return candidates
    .filter((record) => isWorkspacePathMatch({
      workspace: patternWorkspace,
      kind: 'test',
      workspaceRelativePath: record.workspaceRelativePath,
    }))
    .map(workspaceRecordToPath)
}

function isSuiteFilePath(filePath: string | undefined): boolean {
  if (!filePath) return false
  const normalized = filePath.toLowerCase()
  return normalized.endsWith('.suite.yaml') || normalized.endsWith('.suite.yml')
}

async function normalizeDashboardSuitePath(
  filePath: string,
  suiteFileManager?: SuiteFileManager,
): Promise<{ storagePath: string; executionPath: string }> {
  if (!suiteFileManager) {
    throw new Error('Suite file management is required for dashboard-triggered suite runs')
  }

  return suiteFileManager.resolvePath(filePath)
}

/**
 * The `metadata` keys a CLIENT may write through `POST /api/queue/enqueue` (401-23, G-401-18-CR01).
 *
 * IT IS EMPTY, AND THE EMPTINESS IS THE DERIVATION'S ANSWER, not a placeholder. Every key that ever
 * appears in a run's `metadata` is written by this server: `args`/`isSuite` by the enqueue routes,
 * `timeout`/`timeoutSource`/`timeoutBaseMs`/`timeoutBufferMs` by `toExecutionTimeoutMetadata`,
 * `confirmScope` by `/api/runs/trigger` until 432-14 deleted the run-confirm pair (a row written
 * before then may still carry it), and `suiteIndex` by the CLI runner. A caller's OWN labels have their own
 * first-class door on this route — `attributes`, validated by `buildRunRequestAttributes` and
 * persisted in its own column. There is nothing left for a client to legitimately put here.
 *
 * WHAT IT REPLACED, AND WHY THE SHAPE MATTERS. It was a three-key DENYLIST (`args`/`target`/
 * `isSuite`), which is why `POST /api/queue/enqueue { metadata: { confirmScope } }` planted an
 * arbitrary confirm scope on a persisted run row with none of the validation `/api/runs/trigger`
 * applies. Paired with the artifact-payload leak this plan also closes, that bought an attacker the
 * whole escalation: read one browser's scope off `/artifact`, plant it on a run of your choosing,
 * and the confirm for that run is raised in the victim's own dialog. A read-side strip with an open
 * write door is half a fix, and this project has measured one-sided hardening minting regressions
 * three times (388/390/392).
 *
 * IF THIS SET EVER GAINS A KEY, `routes.runs.test.ts` holds the invariant it must satisfy: a
 * client-writable key must also be response-safe (or it is write-only dead weight nobody can read
 * back) and must not be one the server itself writes (or the client can overwrite the server).
 */
export const CLIENT_WRITABLE_QUEUED_RUN_METADATA_KEYS: ReadonlySet<string> = new Set<string>([])

/**
 * The `metadata` keys this SERVER writes onto a run row — never a client.
 *
 * `confirmScope` stays on the list after 432-14 (D-14, D-22): nothing writes it now, but a row this
 * server wrote before then can still hold it, and it is still the server's key rather than one a
 * client may claim.
 */
export const SERVER_OWNED_RUN_METADATA_KEYS: ReadonlySet<string> = new Set<string>([
  'args',
  'confirmScope',
  'isSuite',
  'suiteIndex',
  'target',
  'timeout',
  'timeoutBaseMs',
  'timeoutBufferMs',
  'timeoutSource',
])

type QueuedRunMetadataResult =
  | { readonly ok: true; readonly metadata: Record<string, unknown> }
  | { readonly ok: false; readonly rejected: readonly string[] }

/**
 * The write door's allowlist, and it REFUSES rather than silently dropping.
 *
 * ONE MECHANISM, NOT TWO. A filter that quietly deletes what it will not accept and a validator
 * that rejects it are the same decision made twice, and the version that keeps both is the version
 * where one of them stops being reached. This is the validator; the admitted subset it returns is
 * what reaches `enqueue`. A caller that sends a key the server owns learns so.
 */
function sanitizeQueuedRunMetadata(metadata: unknown): QueuedRunMetadataResult {
  if (metadata === undefined || metadata === null) return { ok: true, metadata: {} }
  if (!isRecord(metadata)) return { ok: false, rejected: ['metadata'] }
  const rejected = Object.keys(metadata)
    .filter((key) => !CLIENT_WRITABLE_QUEUED_RUN_METADATA_KEYS.has(key))
    .sort()
  if (rejected.length > 0) return { ok: false, rejected }
  return { ok: true, metadata: { ...metadata } }
}

/**
 * The largest execution timeout a persisted run row may carry into `executionBackend.execute`.
 *
 * THE CEILING IS NOT THE POINT; THE FLOOR IS. `in-process-backend.ts:211` reads
 * `opts.timeout ?? this.options.defaultTimeout` and then validates — so ANY non-nullish nonsense
 * (`-1`, `NaN`, `'soon'`) skips the default and leaves the run with no reclamation timer at all. A
 * client that could write that key could pin a queue slot open forever. The ceiling closes the same
 * hole from the other side, where a finite but absurd value is a timer that will never fire; a day
 * is well past any dashboard-queued test (the largest the server itself computes is a YAML timeout
 * plus `DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS`), and the point is to keep reclamation reachable,
 * not to second-guess a long suite.
 */
export const MAX_QUEUED_EXECUTION_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * Validate a persisted row's `metadata.timeout` at the seam that consumes it (401-23, T-401-G26).
 *
 * FALLS BACK, NEVER CLAMPS. An unusable value means "this row says nothing about the timeout", and
 * the honest answer to that is the backend's own default — not a number this function invented.
 */
export function sanitizeQueuedExecutionTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value <= 0 || value > MAX_QUEUED_EXECUTION_TIMEOUT_MS) return undefined
  return value
}

// ---- CR-02 (401-18): the confirm scope stops leaving on the READ path ---------------------------

/**
 * The `runs.metadata` keys a RESPONSE may carry.
 *
 * AN ALLOWLIST, NOT A KEYED REMOVAL, and the choice is the whole point of the repair. `confirmScope`
 * is the field that was measured leaving, but a `delete metadata.confirmScope` is one future
 * `metadata.<anything> = <a capability>` away from the identical defect — and this phase has spent
 * four rounds on precisely that class of half-fix. An allowlist fails CLOSED: a field nobody has
 * invented yet does not leave, and adding it here is a deliberate act with this comment attached.
 *
 * WHAT IS ON IT, and why each one:
 *   - `args`, `isSuite`, `target` — what the queue was asked to run. Already published on every
 *     run-reading response since v1; the write path's `sanitizeQueuedRunMetadata` refuses them from
 *     a CLIENT, which is a different question from whether a reader may see the server's own.
 *   - `timeout`, `timeoutSource`, `timeoutBaseMs`, `timeoutBufferMs` — the resolved execution
 *     budget and where it came from, written by `toExecutionTimeoutMetadata`.
 *   - `suiteIndex` — which member of a suite this run's queued row belongs to. (2026-08-27,
 *     405-07: this line used to name the run-detail timeline module that read it, which 405-03
 *     deleted; that plan's scope boundary kept it out of server code, so the dangling reference
 *     was carried here as a deferred item and is scrubbed with the rest of the retired feed.)
 *
 * WHAT IS DELIBERATELY OFF IT: `confirmScope`, the leak this closes — and everything a caller
 * stuffed into `POST /api/queue/enqueue`'s free-form `metadata`, which used to round-trip verbatim
 * to any cross-origin reader. A queue API that accepts arbitrary keys and a run API that hands them
 * back is a self-service exfiltration channel; that it never carried anything sensitive in practice
 * is not a property anything checks.
 */
export const RESPONSE_SAFE_RUN_METADATA_KEYS: ReadonlySet<string> = new Set([
  'args',
  'isSuite',
  'target',
  'timeout',
  'timeoutSource',
  'timeoutBaseMs',
  'timeoutBufferMs',
  'suiteIndex',
])

/**
 * `sanitizeQueuedRunMetadata`'s READ-PATH counterpart (401-18, CR-02).
 *
 * Built in its shape and pointed the other way: that one refuses fields a CLIENT may WRITE, this
 * one refuses fields a RESPONSE may CARRY. `null` and absence round-trip unchanged, so a run with no
 * metadata is serialized exactly as it was.
 */
function sanitizeRunMetadataForResponse(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (metadata === null || metadata === undefined) return metadata ?? null
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (RESPONSE_SAFE_RUN_METADATA_KEYS.has(key)) safe[key] = value
  }
  return safe
}

/**
 * The artifact payload's own copy of the caller's run metadata (G-401-18-CR01).
 *
 * ONE ALLOWLIST, APPLIED AT A SECOND SERIALIZATION SITE — not a second allowlist. `JobQueue.enqueue`
 * writes the SAME `opts.metadata` object into two places (`job-queue.ts:75-78`): the run row, and
 * `run_artifacts.payload.metadata`. 401-18 scrubbed the first and missed the second, and two
 * parallel allowlists is precisely the shape that would let them drift apart again — so this reuses
 * `sanitizeRunMetadataForResponse` rather than declaring keys of its own.
 *
 * `attributes` IS CARRIED THROUGH, and it is the one key that is: the queue MINTS it beside the
 * caller's keys (`job-queue.ts:77`) rather than accepting it, and the run-detail drawer reads it.
 * A blanket delete of `payload.metadata` would close the leak by deleting a shipped field.
 */
function sanitizeArtifactPayloadMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata = payload.metadata
  if (!isRecord(metadata)) return payload
  const safe = sanitizeRunMetadataForResponse(metadata) ?? {}
  return {
    ...payload,
    metadata: 'attributes' in metadata ? { ...safe, attributes: metadata.attributes } : safe,
  }
}

/**
 * Every `DashboardDatabase` read that hands this router a run row or a run artifact row.
 *
 * EXPORTED SO THE CENSUS CAN SCORE IT. `routes.runs.test.ts` parses `database.ts` for the public
 * READS whose return annotation names `RunRow`, `RunArtifactBundle` or `RunArtifactRow` and asserts
 * SET EQUALITY with this list — so a run-row read added to the database, or one dropped from here,
 * reds rather than quietly opening another door.
 *
 * `getRunArtifact` JOINED IN 401-23, AND WHY THE CENSUS HAD TO WIDEN TO SEE IT. The 401-18
 * predicate keyed on `RunRow|RunArtifactBundle` alone, and `getRunArtifact(runId): RunArtifactRow |
 * null` structurally cannot match either name — which is exactly how the artifact payload became
 * the door nobody wrote the strip into. The predicate's SHAPE was the gap, not its diligence.
 */
export const RESPONSE_SAFE_RUN_READ_METHODS = [
  'getNextPendingRun',
  'getPendingRuns',
  'getRun',
  'getRunArtifact',
  'getRunArtifactBundle',
  'getRuns',
  'getRunsBySuiteId',
  'getRunsByTest',
] as const

/**
 * Run-NAMED database members that hand the response layer no run metadata at all (401-23, WR-08).
 *
 * THE OTHER HALF OF A TOTAL FUNCTION. `withResponseSafeRunReads` asserts at CONSTRUCTION that every
 * `/run/i`-named method on the database it is given is accounted for — either wrapped above, or
 * named here with the reason it needs no wrapping. Anything else throws. Before this the wrapper
 * was `Object.create(db, {…overrides…})`, transparent by default, so an unlisted or FUTURE
 * run-reading method reached the response layer through the prototype and returned raw rows.
 *
 * Each name and why it carries no run metadata to a reader:
 *   - `insertRun`, `insertPendingRun`, `insertRunArtifact`, `updateRun`, `updateRunMetadata`,
 *     `updateRunStatus`, `deleteRun` — WRITES. They return an id, a delete tally, a boolean, or
 *     nothing.
 *   - `stageRunArtifact`, `finalizeRunArtifact` — writes that ECHO the row they just wrote, to the
 *     writer that supplied it (`server.ts`, on the raw handle). This router never calls them;
 *     `routes.runs.test.ts` pins that absence, because the echo would otherwise be a door.
 *   - `getRunsByTestCount`, `getRunsBySuiteIdCount` — a `number`.
 *   - `listRunAttributeKeys`, `listRunAttributeValues` — attribute-name/value suggestions built by
 *     the database from the `attributes` column; they never touch `metadata`.
 */
const RUN_READS_WITHOUT_ROWS: ReadonlySet<string> = new Set([
  // 2026-08-27 (405-01, D-01/D-03): the v2 projection's six members.
  //
  // The five WRITES return nothing; they are here for the same reason `insertRun` is.
  //
  // `readRunDetailRows` IS A READ AND IS STILL HERE, and that is the judgement this set exists to
  // make explicit rather than to hide. It returns members, steps and sub-actions — the bus
  // payloads as the subscriber MASKED them (T-363-05) — and NO `RunRow` and no
  // `RunArtifactRow`. It therefore carries none of the run metadata the 401-23 scrub law exists
  // to strip, so wrapping it would be wrapping a shape that has nothing to strip. This router
  // does not call it either: the detail arm dispatches through the injected host, which is the
  // whole of D-03.
  'deleteMemberProjection',
  'incrementRunMemberAttempts',
  'insertRunStep',
  'insertRunSubAction',
  'readRunDetailRows',
  'upsertRunMember',
  'deleteRun',
  'finalizeRunArtifact',
  'getRunsBySuiteIdCount',
  'getRunsByTestCount',
  // 433-30: run ids and a count, no row; each id is dispatched through the agent host.
  'listInsightsWindowRunIds',
  'insertPendingRun',
  'insertRun',
  'insertRunArtifact',
  'listRunAttributeKeys',
  'listRunAttributeValues',
  // 2026-10-16 (442-01, D-01): an owner (pid, incarnation, host), no run metadata.
  'readRunOwner',
  // 2026-10-16 (442-01, D-04): ids and owners only, no run metadata.
  'listRunningRunOwners',
  // 2026-10-16 (442-01, D-04): compare-and-set writes that return a boolean.
  'finalizeOrphanRun',
  'finalizeOwnRun',
  // 2026-10-17 (443-13, GAP-D1): a compare-and-set write that returns a boolean, no run metadata.
  'closeOwnRun',
  // 2026-10-17 (443-02, D-07): a compare-and-set write that returns a boolean, no run metadata.
  'claimRunningRow',
  'stageRunArtifact',
  'updateRun',
  'updateRunMetadata',
  'updateRunStatus',
])

/**
 * Run-named members that are not on `DashboardDatabase`'s TYPE at all (401-23, WR-08).
 *
 * WHY THIS SET HAS TO EXIST. TypeScript's `private` is erased at emit, so every private helper is
 * a live own-property of the prototype and the runtime census below sees all of them. They are not
 * response-layer doors — nothing typed as a `DashboardDatabase` can name them — but a census that
 * ranges the live surface has to say so out loud rather than quietly skipping a shape it does not
 * like. Skipping is how 401-18's predicate came to be blind.
 *
 * A NEW PRIVATE HELPER WITH `run` IN ITS NAME WILL RED THE BUILD until it is added here. That is
 * the intended cost: the alternative is a filter that guesses which names are internal, and a
 * guess is what this whole class of census keeps getting wrong.
 */
const RUN_MEMBERS_NOT_ON_THE_TYPE: ReadonlySet<string> = new Set([
  'buildTrendsFromRuns',
  'getHealedRunIds',
  'getRunAccessibilityEnabled',
  'listRunsForInsights',
  'mapRunArtifactRow',
  'mapRunRow',
  'parseRunAttributes',
  'queryRunsWithAttributePredicates',
  'runMigrations',
  'summarizeAnalyticsRuns',
])

/**
 * Refuse to build a response-layer projection over a database with an unaccounted run-named read.
 *
 * IT RANGES THE LIVE OBJECT, not a source file — the axis the 401-18 census could not reach. A
 * return-annotation grep can only see what an annotation spells; this sees what the router will
 * actually be able to call, including a method inherited from a prototype or attached at runtime.
 */
function assertRunReadsAccountedFor(db: DashboardDatabase, wrapped: ReadonlySet<string>): void {
  const surface = new Set<string>()
  let layer: object | null = db as unknown as object
  while (layer !== null && layer !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(layer)) {
      if (name === 'constructor' || !/run/i.test(name)) continue
      const descriptor = Object.getOwnPropertyDescriptor(layer, name)
      if (descriptor === undefined || typeof descriptor.value !== 'function') continue
      surface.add(name)
    }
    layer = Object.getPrototypeOf(layer) as object | null
  }
  const unaccounted = [...surface]
    .filter((name) => !wrapped.has(name)
      && !RUN_READS_WITHOUT_ROWS.has(name)
      && !RUN_MEMBERS_NOT_ON_THE_TYPE.has(name))
    .sort()
  if (unaccounted.length > 0) {
    throw new Error(
      'withResponseSafeRunReads: unaccounted run-named database method(s): '
      + `${unaccounted.join(', ')}. Add each to RESPONSE_SAFE_RUN_READ_METHODS with a scrubbing `
      + 'override, to RUN_READS_WITHOUT_ROWS with the reason it hands out no run metadata, or to '
      + 'RUN_MEMBERS_NOT_ON_THE_TYPE if it is a private helper no typed caller can reach.',
    )
  }
}

/**
 * The database as the RESPONSE LAYER may read it (401-18, CR-02).
 *
 * WHY A WRAPPER AT THE ROUTER AND NOT A STRIP AT EACH DOOR. The re-derived census found SIX
 * run-serializing responses, not the two the ruling named — the run list, the run detail, the
 * artifact bundle's `run` and `children[].run`, queue status's `pending`/`running`/`recent`, and
 * both analytics run lists. Six doors is a strong argument that the seventh is the one nobody
 * writes the strip into. This is the choke point they all pass through, so a door added next phase
 * is covered by construction rather than by remembering.
 *
 * AND WHY NOT `mapRunRow`, WHICH IS THE OTHER CHOKE POINT. The queue consumer reads the
 * persisted row's own metadata to dispatch the run (`server.ts`); stripping at the DB→row boundary
 * would take from that reader what only a RESPONSE must not carry. `server.ts` and `job-queue.ts`
 * hold the RAW handle and are untouched — this projection exists only inside `createRouter`, which
 * is exactly the layer that serializes.
 *
 * THE PERSISTED VALUE IS NEVER TOUCHED. This is a read projection. 2026-10-01 (432-14, D-14/D-22):
 * the trigger no longer writes a confirm scope and the queue consumer no longer reads one; a row
 * written before then may still hold it, and this projection keeps it from leaving.
 *
 * AND IT FAILS LOUDLY RATHER THAN TRANSPARENTLY (401-23, WR-08). `Object.create(db, {…})` forwards
 * everything it does not override, so before this an unlisted — or merely NEW — run-reading method
 * reached the response layer through the prototype and returned raw rows. That is the structural
 * root of G-401-18-CR01, not a footnote to it: the artifact payload leaked for exactly as long as
 * nobody remembered to write a strip for a door the wrapper was happy to forward. The construction
 * assertion below makes forgetting a build error instead of a leak.
 */
function withResponseSafeRunReads(db: DashboardDatabase): DashboardDatabase {
  const scrubRow = <T>(row: T): T => {
    if (row === null || row === undefined || typeof row !== 'object') return row
    const record = row as unknown as { metadata?: Record<string, unknown> | null }
    if (!('metadata' in record)) return row
    return { ...record, metadata: sanitizeRunMetadataForResponse(record.metadata) } as unknown as T
  }
  const scrubRows = <T>(rows: readonly T[]): T[] => rows.map(scrubRow)
  // ONE artifact scrub, named once and reached by both artifact reads below, so the bare-row door
  // and the bundle door cannot drift into two allowlists.
  const scrubArtifact = (artifact: RunArtifactRow | null): RunArtifactRow | null => {
    if (artifact === null || !isRecord(artifact.payload)) return artifact
    return {
      ...artifact,
      payload: sanitizeArtifactPayloadMetadata(artifact.payload) as unknown as RunArtifactRow['payload'],
    }
  }
  const overrides: Record<string, PropertyDescriptor> = {
    getNextPendingRun: { value: () => scrubRow(db.getNextPendingRun()) },
    getPendingRuns: { value: () => scrubRows(db.getPendingRuns()) },
    getRun: { value: (id: string) => scrubRow(db.getRun(id)) },
    getRuns: {
      value: (...args: Parameters<DashboardDatabase['getRuns']>) => scrubRows(db.getRuns(...args)),
    },
    getRunsBySuiteId: {
      value: (...args: Parameters<DashboardDatabase['getRunsBySuiteId']>) =>
        scrubRows(db.getRunsBySuiteId(...args)),
    },
    getRunsByTest: {
      value: (...args: Parameters<DashboardDatabase['getRunsByTest']>) =>
        scrubRows(db.getRunsByTest(...args)),
    },
    // THE ROUTER HAS NO SERIALIZER OF ITS OWN FOR THIS ONE. `GET /api/runs/:id/artifact` reaches
    // the payload through `getRunArtifactBundle` and serializes it with
    // `sanitizeArtifactForResponse`; a caller reaching for the bare row has no such step, so the
    // projection is its only choke point. Same allowlist, so the two cannot drift.
    getRunArtifact: { value: (runId: string) => scrubArtifact(db.getRunArtifact(runId)) },
    // 405-07 (D-02): the bundle is ONE artifact now. It used to carry the child runs of a suite
    // parent, whose `run` rows this override scrubbed; nothing has written a child row since
    // 402-09, and the shape went with the column. `getRunArtifact` above remains the choke point
    // for the payload itself, and this wrapper delegates to it.
    getRunArtifactBundle: {
      value: (runId: string) => ({ artifact: scrubArtifact(db.getRunArtifactBundle(runId).artifact) }),
    },
  }
  // OVERRIDE ONLY WHAT THE GIVEN DATABASE ACTUALLY HAS. Defining a descriptor for an absent method
  // would MINT one that throws on call — a projection that adds doors is not a projection.
  const present: Record<string, PropertyDescriptor> = {}
  for (const [name, descriptor] of Object.entries(overrides)) {
    if (typeof (db as unknown as Record<string, unknown>)[name] === 'function') present[name] = descriptor
  }
  assertRunReadsAccountedFor(db, new Set(RESPONSE_SAFE_RUN_READ_METHODS))
  return Object.create(db, present) as DashboardDatabase
}

// 2026-08-27 (405-07, D-14) — THE PATH-BASED ARTIFACT MACHINERY IS DELETED.
//
// Four functions and a cleanup routine stood here: a containment resolver, a three-door serving
// verdict over an encoded `:runId/:filename` pair, its fixed-shape refusal, and the filesystem
// sweep a run deletion performed. All five existed to serve or remove artifacts ADDRESSED BY PATH.
//
// Refs are the only artifact addressing now (D-14). A sub-action carries `artifactRefs`, the page
// mints `\`/api/runs/<runId>/artifacts/<sha>\`` from one total route map, and the bytes are reached
// through the `runs.artifact` op — whose containment rule is the evidence store's own, written
// once, rather than a second path assembly in this file that is free to be the weaker one.
//
// AND THE DELETION SWEEP IS NOT REPLACED. `DELETE /api/runs/:id` removes rows and touches nothing
// under the run directory: the event log and the content-addressed blobs there are the run's own
// record, which this server projects and does not own (T-405-27).

async function readWorkspaceHooks(
  configManager: ConfigManager | undefined,
  configPath: string | undefined,
): Promise<{
  hooks: Array<{ name: string }>
  filePath: string
  resolvedHooks: Map<string, import('@vostride/agent-qa-core').HookDefinition>
  errors: string[]
  missing: boolean
  hookRegistryError?: string
}> {
  const hookRegistryManager = createHookRegistryManager(configManager, configPath)
  if (!hookRegistryManager) {
    return {
      hooks: [],
      filePath: '',
      resolvedHooks: new Map(),
      errors: ['Config management not available'],
      missing: true,
      hookRegistryError: 'Config management not available',
    }
  }

  const [hookCatalog, prepareResult] = await Promise.all([
    hookRegistryManager.readCatalog(),
    hookRegistryManager.prepareForExecution(),
  ])

  return {
    hooks: hookCatalog.hooks.map((hook) => ({ name: hook.name })),
    filePath: hookCatalog.filePath,
    resolvedHooks: prepareResult.resolvedHooks,
    errors: hookCatalog.errors,
    missing: hookCatalog.missing,
    hookRegistryError: prepareResult.hookRegistryError,
  }
}

async function readWorkspaceEnvVars(
  workspacePaths: ResolvedWorkspacePaths | undefined,
): Promise<Record<string, string>> {
  if (!workspacePaths) {
    return {}
  }

  try {
    const content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
    return parseEnvFile(content)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`workspace.envFile not found: ${workspacePaths.envFile.absolutePath}`)
    }
    throw error
  }
}

function validateHookRunRequest(body: unknown): {
  overrides: Record<string, string>
  fieldErrors: Array<{ field: 'registry'; code: string; message: string }>
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      overrides: {},
      fieldErrors: [
        {
          field: 'registry',
          code: 'invalid_payload',
          message: 'Hook run payload is required',
        },
      ],
    }
  }

  const rawOverrides = (body as { overrides?: unknown }).overrides
  if (rawOverrides === undefined) {
    return { overrides: {}, fieldErrors: [] }
  }

  if (!Array.isArray(rawOverrides)) {
    return {
      overrides: {},
      fieldErrors: [
        {
          field: 'registry',
          code: 'invalid_overrides',
          message: 'Hook run overrides must be an array',
        },
      ],
    }
  }

  const fieldErrors: Array<{ field: 'registry'; code: string; message: string }> = []
  const overrides: Record<string, string> = {}
  const seenKeys = new Set<string>()

  rawOverrides.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fieldErrors.push({
        field: 'registry',
        code: 'invalid_override',
        message: `Override ${index + 1} must be an object with key and value`,
      })
      return
    }

    const key = typeof (entry as { key?: unknown }).key === 'string'
      ? (entry as { key: string }).key.trim()
      : ''
    const value = (entry as { value?: unknown }).value

    if (!key) {
      fieldErrors.push({
        field: 'registry',
        code: 'invalid_override_key',
        message: `Override ${index + 1} must include a non-empty key`,
      })
      return
    }

    if (seenKeys.has(key)) {
      fieldErrors.push({
        field: 'registry',
        code: 'duplicate_override_key',
        message: `Override key "${key}" is duplicated`,
      })
      return
    }

    if (typeof value !== 'string') {
      fieldErrors.push({
        field: 'registry',
        code: 'invalid_override_value',
        message: `Override "${key}" must have a string value`,
      })
      return
    }

    seenKeys.add(key)
    overrides[key] = value
  })

  return { overrides, fieldErrors }
}

function summarizeHookNetworkLogs(
  networkLogs: Array<{
    url: string
    method: string
    status: number
    startTime: number
    endTime: number
  }> | undefined,
): import('../hooks/hook-registry-types.js').HookRunNetworkLogEntry[] {
  return (networkLogs ?? []).map((entry, index) => ({
    id: `network-${index + 1}`,
    method: entry.method,
    url: entry.url,
    statusCode: Number.isFinite(entry.status) ? entry.status : null,
    durationMs: Number.isFinite(entry.endTime - entry.startTime)
      ? Math.max(0, entry.endTime - entry.startTime)
      : null,
    error: null,
  }))
}

interface RouterDeps {
  db: DashboardDatabase
  workspacePaths?: ResolvedWorkspacePaths
  /**
   * The injected run backend (401-07, D-09).
   *
   * TYPED AGAINST THE INTERFACE, AND NOW ACTUALLY SEPARABLE. It always meant to be, and was not:
   * the retired live-event route reached past the interface for a per-run replay buffer only the
   * concrete class declared, so the seam had exactly one possible implementation. That route and
   * that buffer are gone (405-07, D-19); what this router asks of a backend is the interface.
   */
  executionBackend?: ExecutionBackend
  jobQueue?: JobQueue
  testFileManager?: TestFileManager
  suiteFileManager?: SuiteFileManager
  configManager?: ConfigManager
  configPath?: string
  // 441 GAP-D5: hook output, provider error text and target names leave through this mask. Absent,
  // the router uses the config manager's; with neither, those answers carry no such text.
  declaredSecretMask?: MaskFn

  llmConfig?: DashboardRuntimeLLMConfig
  authFetch?: typeof globalThis.fetch
  sessionManager?: import('../live-editor/session-manager.js').SessionManager
  /**
   * The composed agent host (400-01, D-01). It serves run detail, marks, analysis, knowledge and
   * post-processing. (The run-confirm pair it also served is deleted, 432-14.)
   *
   * INJECTED, and optional because a router built the legacy two-argument way
   * (`createRouter(db)`) has none. Each arm that needs it then answers by name rather than 404 —
   * the route exists, this server was started without a host. See `chat/host.ts` for why the
   * composition happens in the CLI command that starts this server rather than here.
   */
  agentHost?: AgentHost
  /**
   * The run service's readiness predicate, served on the LOCAL door (402-05, D-15).
   *
   * THE SAME FUNCTION THE RUN SERVICE'S `/ok` SERVES — one readiness spelling behind two doors,
   * which is the whole of D-15. It is passed in rather than computed here for the reason `agentHost`
   * is: every fact in it (is a host composed) is known only to the process that composed it, and a
   * copy made here is how the run service and the dashboard start disagreeing about whether this
   * process can run anything.
   *
   * ABSENT IS THE LEGACY MOUNT, NOT AN UNCONFIGURED SERVICE. `agent-qa dashboard` ALWAYS supplies
   * this, because the browser preflight needs an honest answer and a 404 is not one. A router built the legacy
   * two-argument way has none, and that arm answers 503 by name on `agentHost`'s idiom.
   */
  runServiceReadiness?: () => RunServiceReadiness
  /**
   * The started run's session, or nothing — the LOCAL door's attach port (402-08, D-01).
   *
   * THE SAME PORT THE AUTHED DOOR USES, and `server.ts` supplies it by reading
   * `runService.attach` rather than by composing a second lookup: one session registry serves both
   * doors, so a run the remote door can attach to is a run this door can attach to, and there is
   * no second retention window to disagree about.
   *
   * ABSENT MEANS NO RUN SERVICE WAS MOUNTED, which is the same fact as "this process composed no
   * session registry" — unlike `runServiceReadiness` above, whose absence is a legacy mount rather
   * than an unconfigured service. The route then answers 503 BY NAME on the execution routes' own
   * degradation idiom, never a 404 (the route exists) and never an empty stream (which would look
   * like a run that emitted nothing).
   */
  runServiceAttach?: (runId: string) => RunSession | undefined
  /**
   * The `runs.liveurl` mint, DISPATCHED THROUGH THE REGISTRY by the composition root (403 D-03).
   *
   * A FUNCTION, not a signer: this router holds no key and mints nothing. What it does is turn one
   * HTTP shape into one op call and the op's refusals into status codes — which is the whole of a
   * thin client over the function layer.
   *
   * ABSENT MEANS THIS HOST SERVES NO LIVE VIEW, and the route answers 503 BY NAME on
   * `runServiceReadiness`'s idiom — never a 404 (the route exists) and never a URL to nowhere.
   */
  mintLiveUrl?: (runId: string, handle: number) => Promise<RunsLiveUrlResult>
  /**
   * The `editor.liveurl` mint, dispatched through the registry by the composition root (428 D-07).
   * The editor counterpart of `mintLiveUrl`: a function, never a signer. ABSENT MEANS THIS HOST
   * MINTS NO EDITOR VIEW, and the route answers 503 by name.
   */
  mintEditorLiveUrl?: (sessionId: string) => Promise<EditorLiveUrlResult>
  /**
   * The in-process chip sink the post-processing stream relays from (404-05, D-16).
   *
   * INJECTED ON `agentHost`'s OWN IDIOM. The publisher is the CLI's post-run chip emitter — a
   * package this one may not import — so `agent-qa dashboard` creates the relay, hands
   * `relay.publish` to the run door's bridge and hands the relay itself here. One object, two
   * halves of the same process; a relay composed here instead would be a registry the emitter
   * never reaches, and the stream would heartbeat forever at a page whose chips do move.
   *
   * ABSENT MEANS THIS SERVER HAS NO PUSH CHANNEL and the stream arm answers 503 BY NAME — never a
   * 404 (the route exists) and never an empty stream, which would look like a chain that never
   * ticked. The READ route is unaffected: polling works with no relay at all.
   */
  postProcessingRelay?: PostProcessingRelay
}

export function createRouter(deps: RouterDeps): (req: IncomingMessage, res: ServerResponse) => void
export function createRouter(db: DashboardDatabase): (req: IncomingMessage, res: ServerResponse) => void
export function createRouter(dbOrDeps: DashboardDatabase | RouterDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const deps: RouterDeps = 'db' in dbOrDeps && typeof (dbOrDeps as RouterDeps).db === 'object' && 'getRuns' in ((dbOrDeps as RouterDeps).db ?? {})
    ? dbOrDeps as RouterDeps
    : { db: dbOrDeps as DashboardDatabase }
  const { executionBackend, jobQueue, testFileManager, suiteFileManager, configManager, workspacePaths, llmConfig, authFetch, sessionManager } = deps
  const declaredMask = deps.declaredSecretMask ?? configManager?.mask
  // CR-02 (401-18): the response layer reads run rows through the projection, never raw. The host's
  // own reconciliation and the queue keep `deps.db` — see `withResponseSafeRunReads`.
  const db = withResponseSafeRunReads(deps.db)
  const pluginOAuthSessions = new Map<string, PluginOAuthSession>()
  const withCredentialLock = createCredentialLock()
  const connectsInFlight = createConnectInFlight()
  const undoStore = createUndoStore({ retentionMs: UNDO_RETENTION_MS })

  return (req: IncomingMessage, res: ServerResponse) => {
    // The listener's own guarded parse. This router is also mounted directly on its own server,
    // so an unparseable request line is refused here before any route sees it.
    const url = tryParseRequestUrl(req)
    if (url === undefined) {
      json(res, { error: 'Bad Request' }, 400)
      return
    }
    // Every /api request, reads included, passes the same-site and Host check here before any route.
    if (refuseCrossSiteRequest(req) !== undefined) {
      jsonNoCors(res, { error: 'cross_site_refused' }, 403)
      return
    }
    const path = url.pathname

    // 2026-10-01 (432-14, D-14): the run-confirm prefix is no longer dispatched. It was mounted
    // here, ahead of the shared OPTIONS arm, so its answers carried no wildcard grant. Its two paths
    // now fall to the same arms as any path this server does not serve — the shared preflight and
    // the generic 404 — not redirected and not stubbed.

    // 429-01 D-19: the field-merge config write, ahead of the shared OPTIONS arm so its answers
    // never pass through the wildcard grant.
    if (path === '/api/config' && req.method === 'PATCH') {
      if (!configManager) {
        jsonNoCors(res, { error: 'config_unavailable' }, 503)
        return
      }
      registerConfigWriteRoute(req, res, { configManager, undoStore })
      return
    }

    // 429-11 D-24: the Undo door answers every method itself, so no preflight grant reaches it.
    if (path === '/api/config/undo') {
      registerConfigUndoRoute(req, res, {
        configManager,
        undoStore,
        restoreCredential: (name, credential) => withCredentialLock(async () => {
          if (await readAuthEntry(name) !== undefined) return false
          await writeDashboardAuth(name, credential as DashboardAuthCredential)
          return true
        }),
      })
      return
    }

    // 429-06 D-22: the cheap revision read the page polls to notice an outside edit.
    if (path === '/api/config/revision' && req.method === 'GET') {
      if (!configManager) {
        jsonNoCors(res, { error: 'config_unavailable' }, 503)
        return
      }
      registerConfigRevisionRoute(req, res, { configManager })
      return
    }

    // 429-10 D-15/D-17: the draft connect transaction, ahead of the shared OPTIONS arm so its
    // answers never pass through the wildcard grant.
    if (path === '/api/llm/connect' && req.method === 'POST') {
      if (!configManager) {
        jsonNoCors(res, { error: 'config_unavailable' }, 503)
        return
      }
      registerLlmConnectRoute(req, res, {
        configManager,
        withCredentialLock,
        credentialProvider: (name, credential) => credentialProductProvider(name, credential as DashboardAuthCredential),
        connectionTimeoutMs: llmConnectionTestTimeoutMs,
        inFlight: connectsInFlight,
      })
      return
    }

    if (req.method === 'OPTIONS') {
      cors(res)
      return
    }

    // GET /api/auth-states — list safe auth-state metadata only
    if (path === '/api/auth-states' && req.method === 'GET') {
      if (!configManager || !deps.configPath) {
        json(res, { error: 'Auth-state metadata not available' }, 503)
        return
      }
      ;(async () => {
        try {
          const config = await readConfigValues(configManager)
          const targetName = url.searchParams.get('target') ?? undefined
          const authStates = await listAuthStateMetadata({
            configDir: dirname(resolve(deps.configPath!)),
            authStateDir: getConfiguredAuthStateDir(config),
            targetName,
          })
          json(res, { authStates })
        } catch {
          json(res, { error: 'Could not list auth states.' }, 500)
        }
      })()
      return
    }

    // GET /api/runs
    if (path === '/api/runs' && req.method === 'GET') {
      // THE SAME-SITE GUARD, FIRST (405 CR-01) — see `refuseCrossSiteDisplayRead`.
      if (refuseCrossSiteDisplayRead(req, res)) return
      const statuses = url.searchParams.getAll('status')
      const unknownStatus = statuses.find((word) => !isRunStatusWord(word))
      if (unknownStatus !== undefined) {
        jsonNoCors(res, { error: `Unknown run status: ${unknownStatus}.` }, 400)
        return
      }
      const name = url.searchParams.get('name') ?? undefined
      const platform = url.searchParams.get('platform') ?? undefined
      const target = normalizeRunFilterValue(url.searchParams.get('target'))
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0
      const attributePredicatesResult = parseAttributePredicates(url.searchParams)
      if (!attributePredicatesResult.ok) {
        json(res, { error: attributePredicatesResult.error }, 400)
        return
      }

      void readTargetPlatformMap(configManager)
        .then((targetPlatforms) => {
          const allRuns = db.getRuns({
            statuses,
            name,
            from,
            to,
            attributePredicates: attributePredicatesResult.predicates,
          })
          // 405-07 (D-02): a suite row used to be enriched with its child runs as `tests`. Nothing
          // has written a child run row since 402-09 — the members of a suite run are `run_members`
          // on the one row — so this branch could only ever attach an empty array.
          const enrichedRuns = allRuns.map(run => enrichRunRow(run, targetPlatforms))
          const platformFilteredRuns = enrichedRuns.filter(run =>
            matchesPlatformFilter(run, normalizeSupportedPlatform(platform)),
          )
          const targetOptions = Array.from(new Set(
            platformFilteredRuns
              .flatMap(run => [run.targetName, ...(run.tests?.map(test => test.targetName) ?? [])])
              .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
          )).sort((a, b) => a.localeCompare(b))
          const filtered = platformFilteredRuns.filter(run => matchesTargetFilter(run, target))

          const runs = filtered.slice(offset, offset + limit)
          jsonNoCors(res, {
            runs,
            total: filtered.length,
            targets: targetOptions,
          })
        })
        .catch(() => jsonNoCors(res, { error: 'Failed to list runs' }, 500))
      return
    }

    // GET /api/runs/attributes/keys
    if (path === '/api/runs/attributes/keys' && req.method === 'GET') {
      const limitResult = parseBoundedIntegerQueryParam(url.searchParams.get('limit'), 'limit', 1, 100, 50)
      if (!limitResult.ok) {
        json(res, { error: limitResult.error }, 400)
        return
      }
      json(res, {
        keys: db.listRunAttributeKeys({
          limit: limitResult.value,
          q: url.searchParams.get('q') ?? undefined,
        }),
      })
      return
    }

    // GET /api/runs/attributes/values
    if (path === '/api/runs/attributes/values' && req.method === 'GET') {
      const key = url.searchParams.get('key')?.trim()
      if (!key) {
        json(res, { error: 'key is required' }, 400)
        return
      }
      const limitResult = parseBoundedIntegerQueryParam(url.searchParams.get('limit'), 'limit', 1, 100, 50)
      if (!limitResult.ok) {
        json(res, { error: limitResult.error }, 400)
        return
      }
      json(res, {
        values: db.listRunAttributeValues(key, {
          limit: limitResult.value,
          q: url.searchParams.get('q') ?? undefined,
        }),
      })
      return
    }

    // GET /api/runs/:id/artifact
    const runArtifactMatch = path.match(/^\/api\/runs\/([^/]+)\/artifact$/)
    if (runArtifactMatch && req.method === 'GET') {
      // THE SAME-SITE GUARD, FIRST (405 CR-01) — see `refuseCrossSiteDisplayRead`.
      if (refuseCrossSiteDisplayRead(req, res)) return
      const runId = decodeURIComponent(runArtifactMatch[1])
      const run = db.getRun(runId)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const bundle = db.getRunArtifactBundle(runId)
      jsonNoCors(res, {
        run,
        artifact: sanitizeArtifactForResponse(bundle.artifact),
        missingSections: getArtifactMissingSections(bundle.artifact),
      })
      return
    }

    // 2026-08-27 (405-07, D-03/D-19) — FOUR READ ARMS WERE DELETED FROM THIS BLOCK.
    //
    // The accessibility summary, the per-step reasoning trace, the log page and the step list each
    // answered off a v1 projection table with no producer left. `runs.detail` supersedes them: it is ONE read,
    // through the function layer, over the bus-shaped projection the subscriber actually writes —
    // which is D-03's whole point, that the page's read is a read the CLI, MCP and chat can make
    // too. Keeping these beside it would have kept a second, private read path the function layer
    // cannot see, answering from tables nothing fills.
    //
    // They are not redirected and not stubbed. The router's generic 404 answers them, because a
    // route that no longer exists is the honest thing for a client to discover.

    // GET /api/runs/:id/execution-logs
    if (path.startsWith('/api/runs/') && path.endsWith('/execution-logs') && req.method === 'GET') {
      // THE SAME-SITE GUARD, FIRST (405 CR-01) — see `refuseCrossSiteDisplayRead`.
      if (refuseCrossSiteDisplayRead(req, res)) return
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const stepId = url.searchParams.get('stepId') ?? undefined
      const type = url.searchParams.get('type') ?? undefined

      // 405-07 (D-02): a suite run's logs used to be gathered across its child run rows. There are
      // no child rows — one `runs` row per run since 402-09 — and a suite's hook logs are written
      // against that one id, carrying `test_index`/`step_index` to say where in the run they ran.
      const logs = db.getExecutionLogs({ runId: id, stepId, type })
      jsonNoCors(res, { logs })
      return
    }

    // 419 D-13: register before the run catch-all; no private feedback implementation here.
    if (path.startsWith('/api/runs/') && path.endsWith('/mark') && req.method === 'POST') {
      if (deps.agentHost === undefined) {
        jsonNoCors(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, -'/mark'.length))
      } catch {
        jsonNoCors(res, { error: 'invalid_mark_input' }, 400)
        return
      }
      registerRunMarkRoute(req, res, { host: deps.agentHost, runId, boundary: 'human' })
      return
    }

    // 423-21 D-18: the read-tier consequence preview. POST carries runs.mark's exact input; the
    // adapter guards, parses and dispatches the registered op, and this arm owns no feedback logic.
    if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/mark-preview$/.test(path)) {
      if (deps.agentHost === undefined) {
        jsonNoCors(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, -'/mark-preview'.length))
      } catch {
        jsonNoCors(res, { error: 'invalid_run_id' }, 400)
        return
      }
      serveRunMarkPreviewRead(req, res, { runId, host: deps.agentHost, boundary: 'human' })
      return
    }

    // POST /api/runs/:id/cancel — cancel a pending or running execution
    if (path.startsWith('/api/runs/') && path.endsWith('/cancel') && req.method === 'POST') {
      if (!jobQueue) {
        json(res, { error: 'Queue not available' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, path.length - '/cancel'.length))
      } catch {
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      // 2026-10-17 (444-06, D-31): each answer in plain words; the route writes nothing.
      const outcome = jobQueue.cancel(runId)
      switch (outcome.kind) {
        case 'cancelled':
          json(res, { outcome: 'cancelled', message: 'Run cancelled before it started.' })
          return
        case 'stop-requested':
          json(
            res,
            { outcome: 'stop-requested', message: 'Stop requested. The run will end with its own verdict.' },
            202,
          )
          return
        case 'not-stoppable-here':
          json(
            res,
            {
              error: "This run can't be stopped from the dashboard. Stop it where it was started.",
              reason: 'not-stoppable-here',
            },
            409,
          )
          return
        case 'finished':
          json(res, {
            outcome: 'finished',
            status: outcome.status,
            message: `This run already finished: ${outcome.status}.`,
          })
          return
        case 'orphan-finalized':
          json(res, { cancelled: false, message: outcome.message })
          return
        case 'owned-elsewhere':
          json(
            res,
            { error: outcome.message, reason: 'owned-by-live-process', ownerPid: outcome.ownerPid },
            409,
          )
          return
        case 'not-cancellable':
          json(res, { error: 'Run not found or not cancellable' }, 404)
          return
      }
    }

    // DELETE /api/runs/:id
    if (path.startsWith('/api/runs/') && req.method === 'DELETE') {
      const segments = path.split('/')
      if (segments.length !== 4) {
        notFound(res)
        return
      }

      const id = segments[3]

      try {
        const deletedRun = db.deleteRun(id)
        if (!deletedRun.deleted) {
          notFound(res, 'Run not found')
          return
        }

        // 405-07 (D-14 · T-405-27): ROWS ONLY. A filesystem sweep ran here first, removing the
        // run's screenshot and video directories and every path the step rows named. Both the
        // paths and the sweep are gone: what lives under the run directory is the event log and
        // the content-addressed blobs — the run's own record, which this server projects and does
        // not own. A dashboard delete removes the dashboard's projection of a run, nothing more.
        json(res, { deleted: true, deletedRunIds: deletedRun.deletedRunIds })
      } catch {
        json(res, { error: 'Failed to delete run' }, 500)
      }
      return
    }

    // GET /api/runs/:runId/live-url — the LOCAL door onto the mint (403 D-03).
    //
    // ABOVE THE `GET /api/runs/:id` ARM BELOW, and the order is the mechanism: that arm claims
    // every GET under the prefix and answers `Not found` for anything that is not exactly four
    // segments. A live-url route registered after it is a route that never runs — measured, not
    // assumed (the tracer cell's first run answered 404 from precisely that arm).
    //
    // IT DISPATCHES THE OP AND FORMATS NOTHING. The body is the op's result verbatim: a second
    // shaping here would be a second contract for what a `liveUrl` is, free to disagree with the
    // one the function layer published. The refusals are the op's own, mapped by ERROR NAME rather
    // than by matching a message — a message is prose and prose gets rewritten.
    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/live-url$/.test(path)) {
      // THE SAME-SITE GUARD, FIRST — before the door decides anything else about this request.
      //
      // 403 gap round 1 (SC-2, T-403-20). This route hands out the frame socket's ONLY credential,
      // so it is the choke point: a page that cannot obtain a token cannot open the socket. Before
      // this check, a page on any origin open in the developer's own browser could `fetch` a view
      // token and stream the app under test. The loopback bind is not a defence against that — it
      // stops a remote HOST, and the attacker here is the developer's own browser reaching another
      // ORIGIN. The predicate is the chat door's, shared rather than re-derived, and it ADMITS the
      // caller that sends no `Origin` at all (the CLI, `curl`, the conformance harness), which is
      // the local drive this door exists for.
      const crossSite = refuseCrossSiteRequest(req)
      if (crossSite !== undefined) {
        jsonNoCors(res, { error: 'cross_site_refused' }, 403)
        return
      }
      if (!deps.mintLiveUrl) {
        jsonNoCors(res, { error: 'live_view_unavailable' }, 503)
        return
      }
      let liveUrlRunId: string
      try {
        liveUrlRunId = decodeURIComponent(path.slice('/api/runs/'.length, -'/live-url'.length))
      } catch {
        jsonNoCors(res, { error: 'unknown_run' }, 404)
        return
      }
      // THE RAW `handle` PARAMETER THROUGH THE SCHEMA'S OWN READER, on the run-stream door's
      // reasoning one route up: `url.searchParams` resolves `?handle=1&handle=2` to `1`, which is
      // the one answer that reader exists to refuse.
      const rawHandle = handleParamOf(req)
      const parsedHandle = parseHandleParam(rawHandle)
      if (parsedHandle.kind === 'invalid') {
        jsonNoCors(res, { error: 'invalid_handle' }, 400)
        return
      }
      const handle = parsedHandle.kind === 'absent' ? 0 : parsedHandle.index
      // EVERY ARM THROUGH `jsonNoCors`, the success one most of all: the success body IS the token.
      // The refusals go the same way so that the door has one posture rather than a posture per
      // outcome — an arm left on `json()` would be the one a later reader copies.
      void deps.mintLiveUrl(liveUrlRunId, handle).then(
        (result) => { jsonNoCors(res, result) },
        (error: unknown) => {
          const name = error instanceof Error ? error.name : ''
          if (name === 'UnknownRunError') { jsonNoCors(res, { error: 'unknown_run' }, 404); return }
          if (name === 'LiveViewUnavailableError') { jsonNoCors(res, { error: 'live_view_unavailable' }, 503); return }
          jsonNoCors(res, { error: 'live_url_mint_failed' }, 500)
        },
      )
      return
    }

    // GET /api/runs/:runId/artifacts/:sha — a minted ref, resolved to bytes (405-05, D-12/D-13).
    //
    // ABOVE THE DETAIL ARM AND THEREFORE ABOVE THE `/api/runs/:id` CATCH-ALL, on the same
    // measured precedent (RESEARCH Pitfall 2): that arm claims EVERY GET under the prefix.
    //
    // AN ANCHORED TWO-CAPTURE REGEX, and `[^/]+` on both segments so a path with an extra
    // separator matches nothing here rather than being reassembled into something that does.
    //
    // THE RUN ID IS DECODED AND THE SHA IS NOT. A content address is 64 characters drawn from
    // `[0-9a-f]`, none of which percent-encoding can represent differently — so a sha segment that
    // needed decoding is already not a sha, and decoding it would turn `%2e%2e%2f` into a string
    // the contract has to refuse a second time. It is passed RAW to a schema whose regex refuses
    // everything that is not a content address.
    //
    // IT DISPATCHES AND FORMATS NOTHING. The concrete evidence store is not imported by this file
    // and must never be — a source cell in `run-detail-routes.test.ts` asserts that its NAME does
    // not occur here at all, which is why this comment does not spell it either. The containment
    // rule for these bytes is the store's own, reached through the op; a second path assembly here
    // would be a second rule, free to be the weaker one.
    if (req.method === 'GET') {
      const artifactMatch = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(path)
      if (artifactMatch) {
        if (!deps.agentHost) {
          json(res, { error: 'agent_host_unavailable' }, 503)
          return
        }
        let artifactRunId: string
        try {
          artifactRunId = decodeURIComponent(artifactMatch[1] ?? '')
        } catch {
          // An undecodable segment names no run, and the honest answer is the one the op's own
          // input schema gives for an id it refuses.
          json(res, { error: 'invalid_run_id' }, 400)
          return
        }
        serveRunArtifact(req, res, {
          runId: artifactRunId,
          sha: artifactMatch[2] ?? '',
          host: deps.agentHost,
        })
        return
      }
    }

    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/evidence$/.test(path)) {
      if (!deps.agentHost) {
        jsonNoCors(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, -'/evidence'.length))
      } catch {
        jsonNoCors(res, { error: 'invalid_run_id' }, 400)
        return
      }
      serveRunEvidenceRead(req, res, { runId, host: deps.agentHost, boundary: 'human' })
      return
    }

    // 423-21 D-18: marks history, above the `/api/runs/:id` catch-all like its read siblings.
    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/marks$/.test(path)) {
      if (!deps.agentHost) {
        jsonNoCors(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, -'/marks'.length))
      } catch {
        jsonNoCors(res, { error: 'invalid_run_id' }, 400)
        return
      }
      serveRunMarksHistoryRead(req, res, { runId, host: deps.agentHost, boundary: 'human' })
      return
    }

    // GET /api/runs/:id/detail — the durable run-detail projection (405-01, D-03).
    //
    // ABOVE THE `GET /api/runs/:id` CATCH-ALL BELOW, on the live-url and post-processing arms'
    // measured precedent (RESEARCH Pitfall 2): that arm claims EVERY GET under the prefix and
    // answers `Not found` for anything that is not exactly four segments — and
    // `/api/runs/<id>/detail` is four segments, so registered after it this route would be looked
    // up as a run id and refused.
    //
    // IT DISPATCHES AND FORMATS NOTHING. No `db.` call appears in this arm, deliberately: the
    // whole point of D-03 is that the page's read crosses the function layer, where it can be
    // audited and where the CLI and MCP can reach the same answer. Everything below the 503 is
    // `serveRunDetailRead`'s — the op call, the refusal vocabulary, the body.
    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/detail$/.test(path)) {
      if (!deps.agentHost) {
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let detailRunId: string
      try {
        detailRunId = decodeURIComponent(path.slice('/api/runs/'.length, -'/detail'.length))
      } catch {
        // An undecodable segment names no run, and the honest answer is the one the op's own
        // input schema gives for an id it refuses.
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      // THE LOCAL HUMAN DOOR (405-10, D-09): `boundary: 'human'` turns on the same-site guard. The
      // authed REMOTE door's `/run/:runId/detail` passes nothing; both serve the body as stored.
      serveRunDetailRead(req, res, { runId: detailRunId, host: deps.agentHost, boundary: 'human' })
      return
    }

    // GET /api/runs/:id/analysis — one run's resolved verdicts, sentences and clusters (406-01, D-04).
    //
    // ABOVE THE `GET /api/runs/:id` CATCH-ALL BELOW, on the detail arm's measured precedent
    // (RESEARCH Pitfall 2): that arm claims EVERY GET under the prefix and answers `Not found` for
    // anything that is not exactly four segments — and `/api/runs/<id>/analysis` is four segments,
    // so registered after it this route would be looked up as a run id and refused.
    //
    // IT DISPATCHES AND FORMATS NOTHING. `analysis.get` is THE single producer of a run's verdicts
    // and sentences (389 D-11); everything below the 503 is `serveRunAnalysisRead`'s.
    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/analysis$/.test(path)) {
      if (!deps.agentHost) {
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let analysisRunId: string
      try {
        analysisRunId = decodeURIComponent(path.slice('/api/runs/'.length, -'/analysis'.length))
      } catch {
        // An undecodable segment names no run, and the honest answer is the one the op's own
        // input schema gives for an id it refuses.
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      // THE HUMAN DOOR (D-04): `boundary: 'human'` turns on the same-site guard. The authed REMOTE
      // row passes no `boundary`; both serve the body as stored (441 D-07).
      serveRunAnalysisRead(req, res, { runId: analysisRunId, host: deps.agentHost, boundary: 'human' })
      return
    }

    // GET /api/runs/:id/knowledge — what this run used and learned (407-01, D-05/D-06).
    //
    // ABOVE THE `GET /api/runs/:id` CATCH-ALL BELOW, on the detail and analysis arms' measured
    // precedent (RESEARCH Pitfall 2): that arm claims EVERY GET under the prefix and answers
    // `Not found` for anything that is not exactly four segments — and `/api/runs/<id>/knowledge`
    // is four segments, so registered after it this route would be looked up as a run id and
    // refused.
    //
    // IT DISPATCHES AND FORMATS NOTHING. `runs.knowledge` is THE single producer of the Knowledge
    // tab's whole view (407 D-05) — served brief channels, serve-time traces, procedure use, the
    // recorded rung, curator deltas — and everything below the 503 is `serveRunKnowledgeRead`'s.
    // A run whose handoff has been pruned comes back 200 with `kind: 'evidence-incomplete'`, not
    // a 404: D-06 makes that a state the page renders rather than a refusal it has to catch.
    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/knowledge$/.test(path)) {
      if (!deps.agentHost) {
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let knowledgeRunId: string
      try {
        knowledgeRunId = decodeURIComponent(path.slice('/api/runs/'.length, -'/knowledge'.length))
      } catch {
        // An undecodable segment names no run, and the honest answer is the one the op's own
        // input schema gives for an id it refuses.
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      // THE HUMAN DOOR (405-10 D-09): `boundary: 'human'` turns on the same-site guard, as on its
      // two neighbours. The body is served as stored (441 D-07).
      serveRunKnowledgeRead(req, res, {
        runId: knowledgeRunId,
        host: deps.agentHost,
        boundary: 'human',
      })
      return
    }

    // GET /api/runs/:id/post-processing[/stream] — chip truth and its live channel (404-05).
    //
    // ABOVE THE `GET /api/runs/:id` ARM BELOW, on the live-url arm's measured precedent: that arm
    // claims EVERY GET under the prefix and answers `Not found` for anything that is not exactly
    // four segments — and `/api/runs/<id>/post-processing` is four segments, so it would be looked
    // up as a run id and refused. Registered after it, these two routes would never run.
    //
    // THE STREAM ARM IS FIRST, because `/post-processing/stream` also ends with nothing the read
    // arm's own regex would reject if the read arm were written loosely. Both are anchored regexes
    // over a single segment, so neither can claim the other's path whatever the order.
    //
    // THEY DISPATCH AND FORMAT NOTHING. Everything below the 503 arms is
    // `servePostProcessingRead`/`servePostProcessingStream`'s: the op calls, the join, the framing,
    // the 204 and the refusal vocabulary. A second spelling here would be a second answer to what a
    // chip is, which is exactly what D-16/D-17 exist to prevent.
    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/post-processing\/stream$/.test(path)) {
      if (!deps.agentHost) {
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      if (!deps.postProcessingRelay) {
        json(res, { error: 'post_processing_relay_unavailable' }, 503)
        return
      }
      let streamRunId: string
      try {
        streamRunId = decodeURIComponent(
          path.slice('/api/runs/'.length, -'/post-processing/stream'.length),
        )
      } catch {
        // An undecodable segment names no run, and the honest answer is the one the core gives for
        // an id the op's own input schema refuses.
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      servePostProcessingStream(req, res, {
        runId: streamRunId,
        host: deps.agentHost,
        relay: deps.postProcessingRelay,
      })
      return
    }

    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/post-processing$/.test(path)) {
      if (!deps.agentHost) {
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let readRunId: string
      try {
        readRunId = decodeURIComponent(path.slice('/api/runs/'.length, -'/post-processing'.length))
      } catch {
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      servePostProcessingRead(req, res, { runId: readRunId, host: deps.agentHost })
      return
    }

    // GET /api/runs/:id
    if (path.startsWith('/api/runs/') && req.method === 'GET') {
      const segments = path.split('/')
      if (segments.length !== 4) {
        notFound(res)
        return
      }
      // THE SAME-SITE GUARD (405 CR-01) — see `refuseCrossSiteDisplayRead`. It sits AFTER the shape
      // check and not above it because this arm is the `/api/runs/` catch-all: the length test is
      // what decides whether this request is the single-run door at all, and a path that is not
      // that door should keep answering the generic 404 rather than a refusal about a door it
      // never reached.
      if (refuseCrossSiteDisplayRead(req, res)) return
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      // 405-07 (D-03/D-02): `{ run }` AND NOTHING ELSE. This body carried three more keys —
      // `steps` off a v1 projection with no producer, and `attempts`/`tests` off a child-run walk
      // over a column nothing writes. Every one of them was structurally empty on a run this build
      // produced, so a page rendering them rendered an empty tree that looked like a bug rather
      // than like an absence. The run's members, steps and sub-actions are `GET /api/runs/:id/detail`'s,
      // through `runs.detail`.
      jsonNoCors(res, { run })
      return
    }

    // GET /api/stats/costs
    if (path === '/api/stats/costs' && req.method === 'GET') {
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const costStats = db.getCostStats({ from, to })
      json(res, costStats)
      return
    }

    // GET /api/insights/knowledge-changes — what curation changed across the window's runs (433-30,
    // F-433-26). Each run is read through `runs.knowledge`, the op the Knowledge tab reads, on the
    // machine boundary: only counts leave this arm.
    if (path === '/api/insights/knowledge-changes' && req.method === 'GET') {
      if (refuseCrossSiteDisplayRead(req, res)) return
      if (!deps.agentHost) {
        jsonNoCors(res, { status: 'unavailable', reason: 'agent_host_unavailable' }, 503)
        return
      }
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      void readInsightsKnowledgeChanges(deps.agentHost, db, { from, to }).then(
        (body) => { jsonNoCors(res, body) },
        () => { jsonNoCors(res, { status: 'unavailable', reason: 'read_failed' }, 500) },
      )
      return
    }

    // GET /api/token-events/stats
    if (path === '/api/token-events/stats' && req.method === 'GET') {
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const stats = db.getTokenEventStats({ from, to })
      json(res, stats)
      return
    }

    // GET /api/stats
    if (path === '/api/stats' && req.method === 'GET') {
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const scope = url.searchParams.get('scope') ?? undefined
      if (scope !== undefined && scope !== 'passRate') {
        json(res, { error: 'scope must be passRate when provided' }, 400)
        return
      }

      void readAnalyticsScopePredicates(configManager)
        .then((scopeResult) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }
          const configured = scopeResult.predicates.length > 0
          const allStats = db.getStats({ from, to })
          const scopedStats = configured
            ? db.getStats({ from, to, attributePredicates: scopeResult.predicates })
            : allStats
          const stats = scope === 'passRate' && configured ? scopedStats : allStats

          json(res, {
            ...stats,
            scope: {
              configured,
              predicates: scopeResult.predicates,
              scopedCount: configured ? scopedStats.totalRuns : 0,
              totalCount: allStats.totalRuns,
            },
          })
        })
        .catch(() => {
          json(res, { error: 'Unable to read analytics scope' }, 500)
        })
      return
    }

    // 2026-08-27 (405-07, D-14) — THE TWO PATH-SERVING ARMS ARE DELETED.
    //
    // They served bytes addressed as `<runId>/<filename>` under a screenshots or a videos root.
    // Refs are the only artifact addressing now: `GET /api/runs/:runId/artifacts/:sha` above
    // resolves a content address through the `runs.artifact` op, and the store's own containment
    // rule is the one rule those bytes are reached through. There is no video surface at all,
    // because no producer mints a recording ref — an honest absence rather than a surviving path
    // (T-405-28).

    // GET /api/run-readiness — the LOCAL half of D-15's one-predicate-two-doors.
    //
    // NO TOKEN, DELIBERATELY, and that is not a hole in D-06's no-anonymous law: that law governs
    // the SERVICE routes, whose whole premise is a caller from another machine. This is the local
    // dashboard API, and what keeps it local is the 402-05 bind guard — an unauthenticated surface
    // structurally cannot be remote, so the browser preflight does not need a credential to ask
    // whether the run service is configured. The answer carries readiness FACTS and no secret: no
    // token, no count, no entry name.
    if (path === '/api/run-readiness' && req.method === 'GET') {
      if (!deps.runServiceReadiness) {
        json(res, { error: 'This server was started without a run-service readiness predicate' }, 503)
        return
      }
      json(res, deps.runServiceReadiness())
      return
    }

    // GET /api/run-stream/:runId — the LOCAL door onto the run event stream (402-08, D-01/D-13).
    //
    // ONE STREAM CORE BEHIND TWO DOORS. Everything below the 503 arm is `serveRunEventStream`'s:
    // the attach, the handle validation, the filter, the framing, the heartbeat and the close.
    // This handler formats no frame and reads no envelope, deliberately — a second spelling here
    // would agree with the authed door on the day it was written and drift the first time either
    // moves, and the drift would be invisible until somebody diffed them (T-402-27). The parity is
    // measured rather than asserted: `routes.run-stream.test.ts` drives one planted session
    // through BOTH doors over a corpus that includes every refusal class and compares the bytes.
    //
    // NO TOKEN, ON `/api/run-readiness`'s EXACT ARGUMENT (402-05). This is the local dashboard API
    // and what keeps it local is the bind guard, not a credential. The routes that assume a caller
    // from another machine live behind `ownsRunServicePath`, above this router entirely.
    //
    // THE RAW `handle` PARAMETER IS READ BY THE CORE'S OWN READER, not by `url.searchParams`,
    // which resolves `?handle=1&handle=2` to `1` — the one answer that reader exists to refuse.
    if (req.method === 'GET' && path.startsWith('/api/run-stream/')) {
      if (!deps.runServiceAttach) {
        json(res, { error: 'This server was started without a run service to stream from' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/run-stream/'.length))
      } catch {
        // An undecodable id names no run, and the honest answer is the one the core gives for a
        // run this process never started.
        json(res, { error: 'unknown_run' }, 404)
        return
      }
      serveRunEventStream(req, res, {
        runId,
        handleParam: handleParamOf(req),
        // 403-03 (D-13 · INVK-05): the resume point, read from the SAME pair the authed door reads
        // it from. `url.searchParams.get('lastEventId')` would resolve a repeated parameter to its
        // first value — the one answer `lastEventIdParamOf` exists to refuse — and a second
        // header/query precedence rule here would be a second contract for where a client resumes.
        resume: resumePointOf(req.headers['last-event-id'], lastEventIdParamOf(req)),
        attach: deps.runServiceAttach,
      })
      return
    }

    // GET /api/execution/active — list currently running tests
    if (path === '/api/execution/active' && req.method === 'GET') {
      const active = executionBackend ? executionBackend.getActiveExecutions() : []
      json(res, { executions: active })
      return
    }

    // POST /api/queue/enqueue — external API to enqueue a test run
    if (path === '/api/queue/enqueue' && req.method === 'POST') {
      if (!jobQueue) {
        json(res, { error: 'Queue not available' }, 503)
        return
      }
      readJsonBody<{ name: string; file?: string; priority?: number; platform?: string; parallel?: boolean; metadata?: Record<string, unknown>; attributes?: unknown }>(req)
        .then(async (body) => {
          if (!body.name || typeof body.name !== 'string') {
            json(res, { error: 'name is required' }, 400)
            return
          }
          // G-401-18-CR01 (write half): `metadata` is SERVER-DERIVED. Refused before any path is
          // normalized or any attribute built, because the only thing a client can achieve by
          // sending it is overwriting a decision this server already made.
          const queuedMetadata = sanitizeQueuedRunMetadata(body.metadata)
          if (!queuedMetadata.ok) {
            json(res, {
              error: 'metadata is server-derived; these keys are not client-writable: '
                + `${queuedMetadata.rejected.join(', ')}. Use \`attributes\` for caller-supplied labels.`,
            }, 400)
            return
          }
          let normalizedFileTarget: { storagePath: string; executionPath: string } | null = null
          const isSuiteFile = isSuiteFilePath(body.file)
          if (body.file) {
            try {
              normalizedFileTarget = isSuiteFile
                ? await normalizeDashboardSuitePath(body.file, suiteFileManager)
                : await normalizeDashboardWorkspacePath(body.file, workspacePaths, 'test')
            } catch (err) {
              json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
              return
            }
          }
          let attributes: RunAttributes
          try {
            attributes = buildRunRequestAttributes({
              trigger: 'api',
              userAttributes: body.attributes,
            })
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
            return
          }
          const args = normalizedFileTarget ? [normalizedFileTarget.executionPath] : []
          const runId = jobQueue.enqueue({
            name: body.name,
            filePath: normalizedFileTarget?.storagePath,
            // 2026-08-24 (402-09, D-11): NO PARENT KIND IS MINTED. A suite run is ONE run row
            // with member handles, so a parent artifact kind would claim parenthood over rows
            // nothing creates. `isSuiteFile` still travels in `metadata.isSuite` below, and the run's
            // own `suite_id` plus the artifact's `source.kind` snapshot still say it is a suite.
            kind: 'test',
            attributes,
            priority: body.priority,
            platform: body.platform,
            parallel: body.parallel,
            metadata: {
              ...queuedMetadata.metadata,
              args,
              ...(isSuiteFile ? { isSuite: true } : {}),
            },
          })
          const pending = db.getPendingRuns()
          const position = pending.findIndex(r => r.id === runId) + 1
          json(res, { runId, status: 'queued', position }, 202)
        })
        .catch(() => {
          json(res, { error: 'Invalid request body' }, 400)
        })
      return
    }

    // GET /api/queue/status — queue status with pending/running jobs
    if (path === '/api/queue/status' && req.method === 'GET') {
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 20
      const completed = url.searchParams.get('completed') === 'true'
      const pending = db.getPendingRuns()
      const allRuns = db.getRuns({ limit: 100 })
      const running = allRuns.filter(r => r.status === 'running')
      const response: Record<string, unknown> = {
        pending: { count: pending.length, jobs: pending },
        running: { count: running.length, jobs: running },
        concurrency: jobQueue?.getConcurrency() ?? 0,
        activeSlots: jobQueue?.getActiveCount() ?? 0,
      }
      if (completed) {
        const recent = allRuns
          .filter(r => r.status !== 'pending' && r.status !== 'running')
          .slice(0, limit)
        response.recent = recent
      }
      json(res, response)
      return
    }

    // POST /api/runs/trigger — enqueue a live test execution
    if (path === '/api/runs/trigger' && req.method === 'POST') {
      if (!jobQueue) {
        json(res, { error: 'Queue not available' }, 503)
        return
      }
      readJsonBody<{ file?: string; patterns?: string[]; tags?: unknown; noCache?: boolean; triggerSource?: unknown }>(req)
        .then(async (body) => {
          if (body.tags !== undefined) {
            json(res, { error: 'tags are not supported for dashboard-triggered runs' }, 400)
            return
          }
          // 2026-10-01 (432-14, D-14): the click is the whole request. The confirm scope this body
          // used to name, and the validation and persistence that went with it, are deleted with the
          // run-confirm pair; nothing on this road asks a browser anything.
          const triggerSource = parseDashboardRunTriggerSource(body.triggerSource)
          if (!triggerSource.ok) {
            json(res, { error: triggerSource.error }, 400)
            return
          }
          const args: string[] = []
          const isSuiteFile = isSuiteFilePath(body.file)
          let normalizedFileTarget: { storagePath: string; executionPath: string } | null = null
          try {
            normalizedFileTarget = body.file
              ? isSuiteFile
                ? await normalizeDashboardSuitePath(body.file, suiteFileManager)
                : await normalizeDashboardWorkspacePath(body.file, workspacePaths, 'test')
              : null

            if (body.file) {
              args.push(normalizedFileTarget?.executionPath ?? body.file)
            }
            if (body.patterns) {
              if (!Array.isArray(body.patterns)) {
                throw new Error('patterns must be an array')
              }
              for (const pattern of body.patterns) {
                if (typeof pattern !== 'string') {
                  throw new Error('patterns must be strings')
                }
                const matches = await resolveDashboardTestPattern(pattern, workspacePaths)
                args.push(...matches.map((match) => match.executionPath))
              }
            }
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
            return
          }
          const normalizedTestTarget = body.file && !isSuiteFile
            ? normalizedFileTarget
            : null
          if (body.noCache) {
            args.push('--disable-cache')
          }
          const isSuite = Boolean(isSuiteFile)

          let testName = body.file
            ? basename(normalizedFileTarget?.storagePath ?? body.file, '.yaml')
            : 'unknown'

          let fileParallel: boolean | undefined
          let platform: string | undefined

          if (isSuite && body.file && suiteFileManager) {
            // Parse suite YAML for name and platform
            try {
              const content = await suiteFileManager.read(normalizedFileTarget?.storagePath ?? body.file)
              fileParallel = readSuiteYamlParallel(content)
              const parsed = parseYaml(content)
              if (parsed?.name) testName = parsed.name
              platform = parsed?.config?.platform ?? undefined
            } catch { /* fall back to defaults */ }
          } else if (body.file && testFileManager) {
            // Parse test YAML for name, use.parallel, and platform metadata
            try {
              const readPath = normalizedTestTarget?.storagePath ?? body.file
              const content = await testFileManager.read(readPath)
              const metadata = extractTestFileMetadata(content)
              const targetPlatforms = await readTargetPlatformMap(configManager)
              if (metadata.name) testName = metadata.name
              if (metadata.parallel !== null) fileParallel = metadata.parallel
              platform = resolveEffectivePlatform(
                metadata.platform,
                metadata.targetName,
                targetPlatforms,
                platform,
              ) ?? undefined
            } catch { /* fall back to defaults */ }
          }

          const configParallel = await readConfigUseParallel(configManager)
          const effectiveParallel = fileParallel ?? configParallel ?? false
          const executionTimeout = await resolveDashboardExecutionTimeout({
            isSuite,
            file: normalizedFileTarget?.storagePath ?? body.file,
            normalizedTestPath: normalizedTestTarget?.storagePath,
            testFileManager,
            suiteFileManager,
            configManager,
          })

          const runId = jobQueue.enqueue({
            name: testName,
            filePath: normalizedFileTarget?.storagePath ?? body.file,
            // 2026-08-24 (402-09, D-11): no parent kind minted — see the enqueue route above.
            kind: 'test',
            attributes: buildRunRequestAttributes({
              trigger: triggerSource.trigger,
            }),
            platform,
            parallel: effectiveParallel,
            metadata: {
              args,
              isSuite: isSuite || undefined,
              ...toExecutionTimeoutMetadata(executionTimeout),
            },
          })
          json(res, { runId, status: 'queued' }, 202)
        })
        .catch(() => {
          json(res, { error: 'Invalid request body' }, 400)
        })
      return
    }

    // 2026-08-27 (405-07, D-19) — THE LEGACY LIVE-EVENT SSE ARM IS DELETED.
    //
    // It streamed a re-minted frame shape out of the backend's per-run replay buffer, with a
    // `Last-Event-ID` replay and a heartbeat. 405-03 removed the browser half; this removes the
    // route, the buffer and the emission behind it. A live reader attaches to
    // `GET /api/run-stream/:runId`, which frames the run's OWN frozen envelopes; a finished run is
    // read durably through `runs.detail`. One live wire, one durable read — and no second spelling
    // of the wire to drift from the first.

    // POST /api/suites/validate — validate suite YAML content
    if (path === '/api/suites/validate' && req.method === 'POST') {
      if (!suiteFileManager) {
        json(res, { error: 'Suite file management not configured' }, 501)
        return
      }
      readJsonBody<{ content: string }>(req)
        .then(async (body) => {
          const result = await suiteFileManager.validate(body.content ?? '')
          json(res, result)
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // GET /api/suites — list all suite files
    if (path === '/api/suites' && req.method === 'GET') {
      if (!suiteFileManager) {
        json(res, { error: 'Suite file management not configured' }, 501)
        return
      }
      suiteFileManager.list()
        .then(files => json(res, { files }))
        .catch(() => json(res, { error: 'Failed to list suite files' }, 500))
      return
    }

    // POST /api/suites — create a new suite file
    if (path === '/api/suites' && req.method === 'POST') {
      if (!suiteFileManager) {
        json(res, { error: 'Suite file management not configured' }, 501)
        return
      }
      readJsonBody<{ path: string; content: string }>(req)
        .then(async (body) => {
          if (!body.path || typeof body.path !== 'string' || !body.content || typeof body.content !== 'string') {
            json(res, { error: 'Both path and content are required' }, 400)
            return
          }
          if (refusedShownMarkerTarget(res, suiteFileTarget(body.content))) return
          const validation = await suiteFileManager.validate(body.content)
          if (!validation.valid) {
            json(res, {
              error: 'Invalid suite content',
              details: validation.errors,
              missingTests: validation.missingTests,
            }, 400)
            return
          }
          try {
            await suiteFileManager.write(body.path, body.content)
            json(res, { path: body.path, created: true }, 201)
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to create suite file' }, 400)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // DELETE /api/suites/:path — delete a suite file
    if (path.startsWith('/api/suites/') && req.method === 'DELETE') {
      if (!suiteFileManager) {
        json(res, { error: 'Suite file management not configured' }, 501)
        return
      }
      const decodedPath = decodeURIComponent(path.slice('/api/suites/'.length))
      suiteFileManager.delete(decodedPath)
        .then(() => json(res, { deleted: true }))
        .catch((err: any) => {
          if (err.code === 'ENOENT') {
            notFound(res, 'Suite file not found')
            return
          }
          json(res, { error: err.message }, 500)
        })
      return
    }

    // PUT /api/suites/:suite-id — update suite file by suite-id (hard break D-02/D-04)
    if (path.startsWith('/api/suites/') && req.method === 'PUT') {
      if (!suiteFileManager) {
        json(res, { error: 'Suite file management not configured' }, 501)
        return
      }
      const sId = decodeURIComponent(path.slice('/api/suites/'.length))
      readJsonBody<{ content: string }>(req)
        .then(async (body) => {
          if (!body.content || typeof body.content !== 'string') {
            json(res, { error: 'Content is required' }, 400)
            return
          }
          if (refusedShownMarkerTarget(res, suiteFileTarget(body.content))) return
          const found = await suiteFileManager.findBySuiteId(sId)
          if (!found) {
            notFound(res, 'Suite not found')
            return
          }
          const validation = await suiteFileManager.validate(body.content)
          if (!validation.valid) {
            json(res, {
              error: 'Invalid suite content',
              details: validation.errors,
              missingTests: validation.missingTests,
            }, 400)
            return
          }
          try {
            await suiteFileManager.write(found.path, body.content)
            json(res, { path: found.path, updated: true })
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update suite file' }, 400)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // GET /api/suites/:suite-id — read suite file by suite-id (hard break D-02/D-04/D-05)
    if (path.startsWith('/api/suites/') && req.method === 'GET') {
      if (!suiteFileManager) {
        json(res, { error: 'Suite file management not configured' }, 501)
        return
      }
      const sId = decodeURIComponent(path.slice('/api/suites/'.length))
      suiteFileManager.findBySuiteId(sId)
        .then(result => {
          if (!result) {
            notFound(res, 'Suite not found')
            return
          }
          json(res, { path: result.path, content: result.content, suiteId: sId })
        })
        .catch(() => notFound(res, 'Suite not found'))
      return
    }

    // POST /api/tests/validate — validate YAML content (must be before parameterized /api/tests/:path)
    if (path === '/api/tests/validate' && req.method === 'POST') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      readJsonBody<{ content: string; filePath?: string }>(req)
        .then(async (body) => {
          const isSuite = body.filePath?.endsWith('.suite.yaml') || body.filePath?.endsWith('.suite.yml')
          if (isSuite && suiteFileManager) {
            const result = await suiteFileManager.validate(body.content ?? '')
            json(res, result)
          } else {
            const result = await testFileManager.validate(body.content ?? '')
            json(res, result)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // GET /api/tests — list all test files
    if (path === '/api/tests' && req.method === 'GET') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      testFileManager.list()
        .then(async files => {
          const targetPlatforms = await readTargetPlatformMap(configManager)
          const resolvedFiles = files.map((file) => ({
            ...file,
            platform: resolveEffectivePlatform(file.platform, file.targetName, targetPlatforms),
          }))
          const targets = Array.from(
            new Set(
              resolvedFiles
                .map((file) => file.targetName)
                .filter((value): value is string => typeof value === 'string' && value.length > 0),
            ),
          )
          json(res, { files: resolvedFiles, targets })
        })
        .catch(() => json(res, { error: 'Failed to list test files' }, 500))
      return
    }

    // POST /api/tests — create a new test file
    if (path === '/api/tests' && req.method === 'POST') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      readJsonBody<{ path: string; content: string }>(req)
        .then(async (body) => {
          if (!body.path || typeof body.path !== 'string' || !body.content || typeof body.content !== 'string') {
            json(res, { error: 'Both path and content are required' }, 400)
            return
          }
          if (refusedShownMarkerTarget(res, targetsForMarkerCheck(body.content))) return
          const validation = await testFileManager.validate(body.content)
          if (!validation.valid) {
            json(res, { error: 'invalid_test_file', errors: validation.errors }, 400)
            return
          }
          try {
            await testFileManager.write(body.path, body.content)
            json(res, { path: body.path, created: true }, 201)
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to create test file' }, 400)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // DELETE /api/tests/:t_id — delete test file by test-id
    if (path.startsWith('/api/tests/') && req.method === 'DELETE') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      const tId = decodeURIComponent(path.slice('/api/tests/'.length))
      testFileManager.findByTestId(tId)
        .then(async (found) => {
          if (!found) {
            notFound(res, 'Test not found')
            return
          }
          await testFileManager.delete(found.path)
          json(res, { deleted: true, path: found.path })
        })
        .catch((err: unknown) => {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code === 'ENOENT') {
            notFound(res, 'Test not found')
            return
          }
          json(res, { error: err instanceof Error ? err.message : 'Failed to delete test file' }, 500)
        })
      return
    }

    // PUT /api/tests/:t_id — update test file by test-id
    if (path.startsWith('/api/tests/') && req.method === 'PUT') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      const tId = decodeURIComponent(path.slice('/api/tests/'.length))
      readJsonBody<{ content: string }>(req)
        .then(async (body) => {
          if (!body.content || typeof body.content !== 'string') {
            json(res, { error: 'Content is required' }, 400)
            return
          }
          if (refusedShownMarkerTarget(res, targetsForMarkerCheck(body.content))) return
          const found = await testFileManager.findByTestId(tId)
          if (!found) {
            notFound(res, 'Test not found')
            return
          }
          const validation = await testFileManager.validate(body.content)
          if (!validation.valid) {
            json(res, { error: 'invalid_test_file', errors: validation.errors }, 400)
            return
          }
          try {
            await testFileManager.write(found.path, body.content)
            json(res, { path: found.path, updated: true })
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update test file' }, 400)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // GET /api/tests/:t_id — read test file by test-id
    if (path.startsWith('/api/tests/') && req.method === 'GET') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      const tId = decodeURIComponent(path.slice('/api/tests/'.length))
      testFileManager.findByTestId(tId)
        .then(result => {
          if (!result) {
            notFound(res, 'Test not found')
            return
          }
          json(res, { path: result.path, content: result.content, testId: tId })
        })
        .catch(() => notFound(res, 'Test not found'))
      return
    }

    // GET /api/analytics/tests
    if (path === '/api/analytics/tests' && req.method === 'GET') {
      const minRuns = url.searchParams.has('minRuns') ? parseInt(url.searchParams.get('minRuns')!, 10) : 3
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50
      const tests = db.getFlakyTests({ minRuns, limit })
      const result = tests.map(t => {
        return { ...t, isFlaky: t.flakyScore >= 0.4 }
      })
      json(res, { tests: result })
      return
    }

    // GET /api/analytics/test-summaries — each listed test's rate and last run, as its viewer reads them
    if (path === '/api/analytics/test-summaries' && req.method === 'GET') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      Promise.all([testFileManager.list(), readAnalyticsScopePredicates(configManager)])
        .then(([files, scopeResult]) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }
          // The rate is the figure the viewer opens on; the last run stays unscoped, as its run list is.
          const scope = scopeResult.predicates.length > 0 ? { attributePredicates: scopeResult.predicates } : undefined
          const tests = files.map((file) => {
            const test = { ...(file.testId ? { testId: file.testId } : {}), filePath: file.path }
            const [last] = db.getRunsByTest(test, { limit: 1 })
            const lastRun = lastRunOf(last)
            return {
              path: file.path,
              testId: file.testId,
              ...passRateOf(db.getTestTrends(test, scope)),
              lastRun: lastRun ? { ...lastRun, memberOutcome: last?.memberOutcome ?? null } : null,
            }
          })
          json(res, { tests })
        })
        .catch(() => json(res, { error: 'Failed to read run summaries' }, 500))
      return
    }

    // GET /api/analytics/suite-summaries — each listed suite's rate, last run, target and platform
    if (path === '/api/analytics/suite-summaries' && req.method === 'GET') {
      if (!suiteFileManager) {
        json(res, { error: 'Suite file management not configured' }, 501)
        return
      }
      Promise.all([suiteFileManager.list(), readTargetPlatformMap(configManager), readAnalyticsScopePredicates(configManager)])
        .then(([files, targetPlatforms, scopeResult]) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }
          const scope = scopeResult.predicates.length > 0 ? { attributePredicates: scopeResult.predicates } : undefined
          const suites = files.map((file) => {
            if (!file.suiteId) {
              return { path: file.path, suiteId: null, passRate: null, passed: 0, decided: 0, lastRun: null, platform: null, targetName: null }
            }
            const runs = db.getRunsBySuiteId(file.suiteId)
            return {
              path: file.path,
              suiteId: file.suiteId,
              ...passRateOf(db.getSuiteTrends(file.suiteId, scope)),
              lastRun: lastRunOf(runs[0]),
              ...suiteTargetOf(runs, targetPlatforms),
            }
          })
          json(res, { suites })
        })
        .catch(() => json(res, { error: 'Failed to read run summaries' }, 500))
      return
    }

    // GET /api/analytics/tests/:name
    if (path.startsWith('/api/analytics/tests/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/analytics/tests/'.length))
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0
      const from = url.searchParams.get('from') ?? undefined
      const testId = url.searchParams.get('testId') || undefined
      const filePath = url.searchParams.get('filePath') || undefined
      if (!testId && !filePath) {
        json(res, { error: 'testId or filePath is required' }, 400)
        return
      }
      const test = { ...(testId ? { testId } : {}), ...(filePath ? { filePath } : {}) }
      const memberClasses = (runs: RunRow[]) => runs.map(r => memberOutcomeClass(r.memberOutcome ?? null))
      void readAnalyticsScopePredicates(configManager)
        .then((scopeResult) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }

          const runs = db.getRunsByTest(test, { limit, offset })
          const total = db.getRunsByTestCount(test)
          const trends = db.getTestTrends(test, { from })
          const allRunsForFlakiness = db.getRunsByTest(test, { limit: 100 })
          const flakyMetrics = calculateFlakyMetrics(memberClasses(allRunsForFlakiness))
          const flakyScore = flakyMetrics.score
          const configured = scopeResult.predicates.length > 0
          const scopedRuns = configured
            ? db.getRunsByTest(test, { limit, offset, attributePredicates: scopeResult.predicates })
            : runs
          const scopedTotal = configured
            ? db.getRunsByTestCount(test, { attributePredicates: scopeResult.predicates })
            : total
          const scopedTrends = configured
            ? db.getTestTrends(test, { from, attributePredicates: scopeResult.predicates })
            : trends
          const scopedRunsForFlakiness = configured
            ? db.getRunsByTest(test, { limit: 100, attributePredicates: scopeResult.predicates })
            : allRunsForFlakiness
          const scopedFlakyScore = calculateFlakyMetrics(memberClasses(scopedRunsForFlakiness)).score

          json(res, {
            name,
            runs,
            total,
            trends,
            isFlaky: flakyScore >= 0.4 && flakyMetrics.statusCount >= 3,
            flakyScore,
            scope: {
              configured,
              predicates: scopeResult.predicates,
              scopedCount: scopedTotal,
              totalCount: total,
            },
            ...(configured ? {
              scopedRuns,
              scopedTrends,
              scopedFlakyScore,
            } : {}),
          })
        })
        .catch(() => json(res, { error: 'Failed to read analytics scope' }, 500))
      return
    }

    // GET /api/analytics/suites/:suiteId
    if (path.startsWith('/api/analytics/suites/') && req.method === 'GET') {
      if (!suiteFileManager) {
        json(res, { error: 'Suite file management not configured' }, 501)
        return
      }

      const suiteId = decodeURIComponent(path.slice('/api/analytics/suites/'.length))
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0
      const from = url.searchParams.get('from') ?? undefined

      Promise.all([suiteFileManager.findBySuiteId(suiteId), readAnalyticsScopePredicates(configManager)])
        .then(([result, scopeResult]) => {
          if (!result) {
            notFound(res, 'Suite not found')
            return
          }
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }

          const runs = db.getRunsBySuiteId(suiteId, { limit, offset })
          const total = db.getRunsBySuiteIdCount(suiteId)
          const trends = db.getSuiteTrends(suiteId, { from })
          const allRunsForFlakiness = db.getRunsBySuiteId(suiteId, { limit: 100 })
          const flakyMetrics = calculateFlakyMetrics(allRunsForFlakiness.map(r => runStatusClass(r.status)))
          const flakyScore = flakyMetrics.score
          const configured = scopeResult.predicates.length > 0
          const scopedRuns = configured
            ? db.getRunsBySuiteId(suiteId, { limit, offset, attributePredicates: scopeResult.predicates })
            : runs
          const scopedTotal = configured
            ? db.getRunsBySuiteIdCount(suiteId, { attributePredicates: scopeResult.predicates })
            : total
          const scopedTrends = configured
            ? db.getSuiteTrends(suiteId, { from, attributePredicates: scopeResult.predicates })
            : trends
          const scopedRunsForFlakiness = configured
            ? db.getRunsBySuiteId(suiteId, { limit: 100, attributePredicates: scopeResult.predicates })
            : allRunsForFlakiness
          const scopedFlakyScore = calculateFlakyMetrics(scopedRunsForFlakiness.map(r => runStatusClass(r.status))).score

          json(res, {
            suiteId,
            runs,
            total,
            trends,
            isFlaky: flakyScore >= 0.4 && flakyMetrics.statusCount >= 3,
            flakyScore,
            scope: {
              configured,
              predicates: scopeResult.predicates,
              scopedCount: scopedTotal,
              totalCount: total,
            },
            ...(configured ? {
              scopedRuns,
              scopedTrends,
              scopedFlakyScore,
            } : {}),
          })
        })
        .catch(() => notFound(res, 'Suite not found'))
      return
    }

    // GET /api/analytics/breakdowns
    if (path === '/api/analytics/breakdowns' && req.method === 'GET') {
      const dimension = url.searchParams.get('dimension')
      if (dimension !== 'test' && dimension !== 'suite' && dimension !== 'platform') {
        json(res, { error: 'dimension must be one of: test, suite, platform' }, 400)
        return
      }

      const limitResult = parseBoundedIntegerQueryParam(url.searchParams.get('limit'), 'limit', 1, 100, 25)
      if (!limitResult.ok) {
        json(res, { error: limitResult.error }, 400)
        return
      }

      const fromResult = parseIsoDateQueryParam(url.searchParams.get('from'), 'from')
      if (!fromResult.ok) {
        json(res, { error: fromResult.error }, 400)
        return
      }

      const toResult = parseIsoDateQueryParam(url.searchParams.get('to'), 'to')
      if (!toResult.ok) {
        json(res, { error: toResult.error }, 400)
        return
      }

      const scope = url.searchParams.get('scope') ?? undefined
      if (scope !== undefined && scope !== 'passRate') {
        json(res, { error: 'scope must be passRate when provided' }, 400)
        return
      }

      void readAnalyticsScopePredicates(configManager)
        .then(async (scopeResult) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }

          const configured = scopeResult.predicates.length > 0
          const attributePredicates = scope === 'passRate' && configured ? scopeResult.predicates : undefined
          const rows = db.getInsightsBreakdown(dimension as InsightsBreakdownDimension, {
            from: fromResult.value,
            to: toResult.value,
            limit: limitResult.value,
            attributePredicates,
          })
          const scopedCount = configured
            ? db.getInsightsBreakdown(dimension as InsightsBreakdownDimension, {
                from: fromResult.value,
                to: toResult.value,
                limit: 100,
                attributePredicates: scopeResult.predicates,
              }).reduce((sum, row) => sum + row.runs, 0)
            : 0
          const totalCount = db.getInsightsBreakdown(dimension as InsightsBreakdownDimension, {
            from: fromResult.value,
            to: toResult.value,
            limit: 100,
          }).reduce((sum, row) => sum + row.runs, 0)
          const payload = {
            dimension,
            rows,
            scope: {
              configured,
              predicates: scopeResult.predicates,
              scopedCount,
              totalCount,
            },
          }

          if (dimension !== 'suite' || !suiteFileManager) {
            json(res, payload)
            return
          }

          const files = await suiteFileManager.list()
          const suiteNames = new Map(
            files
              .filter((file) => typeof file.suiteId === 'string' && file.suiteId.length > 0)
              .map((file) => [file.suiteId as string, file.name]),
          )

          json(res, {
            ...payload,
            rows: rows.map((row) => ({
              ...row,
              label: row.suiteId ? (suiteNames.get(row.suiteId) ?? row.label) : row.label,
            })),
          })
        })
        .catch(() => {
          json(res, { error: 'Unable to read analytics breakdown scope' }, 500)
        })
      return
    }

    // GET /api/app-metadata — return narrow non-sensitive app metadata
    if (path === '/api/app-metadata' && req.method === 'GET') {
      const version = getAgentQaVersion().trim() || '0.0.0'
      ;(async () => {
        try {
          const status = await getAgentQaUpdateStatus()
          const latestVersion = typeof status.latestVersion === 'string'
            ? status.latestVersion.trim()
            : ''
          if (status.updateAvailable === true && latestVersion) {
            json(res, { version, update: { latestVersion } })
            return
          }
        } catch {
          // Keep app metadata available even when update checks fail.
        }

        json(res, { version })
      })().catch(() => {
        json(res, { version })
      })
      return
    }

    // GET /api/config/targets — return registered target names
    if (path === '/api/config/targets' && req.method === 'GET') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const config = await readConfigValues(configManager)
          const configObj = config as Record<string, unknown>
          const registry = configObj.registry as Record<string, unknown> | undefined
          const targets = registry?.targets as Record<string, unknown> | undefined
          const names = targets ? Object.keys(targets) : []
          const shown = withDeclaredMask(declaredMask, (mask) => names.map((name) => mask(name)))
          if (shown === undefined) {
            json(res, { error: 'masking_unavailable' }, 500)
            return
          }
          json(res, { targets: shown })
        } catch (err: unknown) {
          const message = err instanceof Error
            ? withDeclaredMask(declaredMask, (mask) => mask(err.message))
            : undefined
          json(res, { error: message ?? 'Failed to read targets' }, 500)
        }
      })()
      return
    }

    // GET /api/config — return masked config with active provider info
    if (path === '/api/config' && req.method === 'GET') {
      // 429-41 (CR-02): the answer carries file text and the file's absolute path, so it is read
      // same-site only and no outcome grants a cross-origin read.
      if (refuseCrossSiteDisplayRead(req, res)) return
      if (!configManager) {
        jsonNoCors(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const read = await configManager.readMasked()
          if (read.kind === 'file_invalid') {
            jsonNoCors(res, { error: 'file_invalid', message: read.message }, 409)
            return
          }
          const { config, revision, lines, fileIssues } = read
          const registry = config.registry as Record<string, unknown> | undefined
          const llms = (registry?.llms ?? config.llms) as Array<Record<string, unknown>> | undefined
          const use = config.use as Record<string, unknown> | undefined
          const activeLlm = (use?.llm ?? config.defaultLLM) as string | undefined
          const defaultCfg = Array.isArray(llms)
            ? llms.find((c) => c?.name === activeLlm)
            : undefined
          const provider = (defaultCfg?.provider as string) ?? null
          jsonNoCors(res, {
            config,
            provider,
            revision,
            file: { path: deps.configPath ?? null, lines },
            ...(fileIssues.length > 0 ? { fileIssues } : {}),
          })
        } catch (err: unknown) {
          jsonNoCors(res, { error: err instanceof Error ? err.message : 'Failed to read config' }, 500)
        }
      })()
      return
    }

    // DELETE /api/auth/:configName — remove stored credential
    if (path.startsWith('/api/auth/') && req.method === 'DELETE') {
      const segments = path.split('/')
      if (segments.length === 4 && segments[2] === 'auth') {
        const providerName = decodeURIComponent(segments[3])
        if (providerName === 'status' || providerName === 'credential' || providerName === 'oauth') {
          // Fall through to other handlers
        } else {
          if (refuseCrossSiteRequest(req) !== undefined) {
            jsonNoCors(res, { error: 'cross_site_refused' }, 403)
            return
          }
          // 429-11 D-24: the removed entry is held server-side for Undo; the answer never carries it.
          ;(async () => {
            try {
              const removed = await withCredentialLock(async () => {
                const credential = await readAuthEntry(providerName)
                if (credential === undefined) return undefined
                await removeAuth(providerName)
                return credential
              })
              if (removed === undefined) {
                jsonNoCors(res, { deleted: false })
                return
              }
              const undo = undoStore.put({ kind: 'credential', name: providerName, credential: removed }, Date.now())
              jsonNoCors(res, { deleted: true, undo })
            } catch (err: unknown) {
              jsonNoCors(res, { error: err instanceof Error ? err.message : 'Failed to delete credential' }, 500)
            }
          })()
          return
        }
      }
    }

    // GET /api/auth/status — return credential info from auth store
    if (path === '/api/auth/status' && req.method === 'GET') {
      ;(async () => {
        try {
          const credentials: Array<{
            type: string
            provider: string
            configName: string
            expires: number | null
            source: string
          }> = []
          const store = await readAuth() as Record<string, DashboardAuthCredential>
          for (const [key, cred] of Object.entries(store)) {
            if (cred) {
              let provider = cred.provider ?? key
              if (cred.type === 'oauth') {
                provider = toProductProviderLabel(provider)
              } else if (cred.type === 'bearer') {
                provider = cred.provider
              }
              credentials.push({
                type: cred.type,
                provider,
                configName: key,
                expires: cred.type === 'oauth' ? cred.tokens.expires : null,
                source: 'auth-store',
              })
            }
          }
          json(res, { credentials })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read auth status' }, 500)
        }
      })()
      return
    }

    // GET /api/llm/providers — built-in and plugin-provided LLM provider metadata
    if (path === '/api/llm/providers' && req.method === 'GET') {
      json(res, {
        providers: [
          ...builtinLLMProviderMetadata(),
          ...listLLMAuthProviderPlugins().map(serializeAuthProviderPlugin),
        ],
      })
      return
    }

    if (path === '/api/llm/catalog' && req.method === 'GET') {
      json(res, { catalog: getModelCatalog() })
      return
    }

    if (path === '/api/llm/catalog/live' && req.method === 'POST') {
      readJsonBody<{
        configName?: string
        baseURL?: string
        providerHeaders?: Record<string, string>
      }>(req)
        .then(async (body) => {
          const rawBody = body as Record<string, unknown>
          if ('apiKey' in rawBody) {
            json(res, {
              error: 'invalid_request',
              message: 'apiKey is not accepted; save credentials for the named config instead.',
            }, 400)
            return
          }

          const staticOpenAI = getModelCatalog()['openai-compatible']
          const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : ''
          if (!baseURL) {
            json(res, { models: staticOpenAI })
            return
          }

          const headers: Record<string, string> = {}
          if (body.providerHeaders !== undefined) {
            for (const [key, value] of Object.entries(body.providerHeaders)) {
              if (typeof value === 'string') headers[key] = value
            }
          }

          const llmCandidate: Record<string, unknown> = {
            provider: 'openai-compatible',
            model: 'catalog-live-probe',
            baseURL,
          }
          if (Object.keys(headers).length > 0) {
            llmCandidate.providerHeaders = headers
          }

          const parsedConfig = ModelConfigSchema.safeParse(llmCandidate)
          if (!parsedConfig.success) {
            json(res, {
              error: 'invalid_request',
              message: parsedConfig.error.issues
                .map((issue: { path: PropertyKey[]; message: string }) => `${issue.path.map(String).join('.') || 'config'}: ${issue.message}`)
                .join('; '),
            }, 400)
            return
          }

          const configName = typeof body.configName === 'string' ? body.configName.trim() : ''
          const llmConfig = parsedConfig.data
          const coreAuth = await import('@vostride/agent-qa-core') as typeof import('@vostride/agent-qa-core') & {
            resolveLLMAuth: (name: string, config: typeof llmConfig) => Promise<
              | { kind: 'api-key'; apiKey: string }
              | { kind: 'bearer-token'; token: string }
              | { kind: 'auth-fetch'; fetch: typeof globalThis.fetch; modelAdapter: 'openai-responses' | 'anthropic-messages' }
              | { kind: 'unauthenticated'; message: string }
              | { kind: 'missing'; message: string }
            >
          }
          const resolvedAuth = await coreAuth.resolveLLMAuth(configName, llmConfig)
          if (resolvedAuth.kind === 'api-key') {
            headers.Authorization ??= `Bearer ${resolvedAuth.apiKey}`
          } else if (resolvedAuth.kind === 'bearer-token') {
            headers.Authorization ??= `Bearer ${resolvedAuth.token}`
          }

          const live = await fetchLiveModels({
            baseURL,
            headers: Object.keys(headers).length > 0 ? headers : undefined,
          })
          json(res, { models: mergeCatalog(staticOpenAI, live) })
        })
        .catch(() => json(res, { error: 'invalid_request' }, 400))
      return
    }

    if (path.startsWith('/api/auth/plugin/')) {
      pruneExpiredPluginOAuthSessions(pluginOAuthSessions)
      const segments = path.split('/')
      const provider = segments.length >= 6 ? decodeURIComponent(segments[4] ?? '') : ''
      const action = segments.length >= 6 ? segments[5] : ''
      // 429-09: start and code exchange plant a machine-wide credential, so both are same-site only
      // and no answer on them carries a cross-origin grant.
      const authDoor = req.method === 'POST' && (action === 'start' || action === 'exchange')
      if (authDoor && refuseCrossSiteRequest(req) !== undefined) {
        jsonNoCors(res, { error: 'cross_site_refused' }, 403)
        return
      }
      const plugin = provider ? getLLMAuthProviderPlugin(provider) : undefined

      if (!plugin) {
        ;(authDoor ? jsonNoCors : json)(res, { error: `Auth plugin provider "${provider}" is not registered` }, 404)
        return
      }

      if (action === 'start' && req.method === 'POST') {
        readJsonBody<{ configName?: string; callbackUrl?: string }>(req)
          .then(async (body) => {
            if (!plugin.startAuth) {
              jsonNoCors(res, { error: `Provider "${provider}" does not support dashboard auth start` }, 400)
              return
            }

            try {
              const target = await requirePluginAuthConfig(configManager, body.configName, plugin)
              if (!target.ok) {
                jsonNoCors(res, credentialRefusalBody(target), target.status)
                return
              }
              const started = await plugin.startAuth({
                configName: target.configName,
                callbackUrl: typeof body.callbackUrl === 'string' ? body.callbackUrl : undefined,
              })
              const sessionId = randomUUID()
              const session: PluginOAuthSession = {
                providerId: plugin.providerId,
                credentialProviderId: plugin.credentialProviderId,
                configName: target.configName,
                sessionState: started.sessionState,
                cleanup: started.cleanup,
                status: 'pending',
                expiresAt: Date.now() + PLUGIN_OAUTH_SESSION_TTL_MS,
              }
              pluginOAuthSessions.set(sessionId, session)

              if (started.waitForTokens) {
                started.waitForTokens
                  .then(async (tokens: OAuthTokens) => {
                    const conflict = await withCredentialLock(async () => {
                      if (await credentialConflictAt(target.configName, plugin.providerId)) return true
                      await writeDashboardAuth(target.configName, {
                        type: 'oauth',
                        provider: plugin.credentialProviderId,
                        tokens,
                      })
                      return false
                    })
                    if (conflict) throw new Error(CREDENTIAL_PROVIDER_CONFLICT.message)
                    session.status = 'completed'
                  })
                  .catch((err: unknown) => {
                    session.status = 'error'
                    session.error = err instanceof Error ? err.message : 'Authentication failed'
                  })
                  .finally(() => cleanupPluginOAuthSession(session))
              }

              jsonNoCors(res, {
                authorizeUrl: started.authorizeUrl,
                sessionId,
                mode: plugin.dashboardAuth.mode,
                created: target.created,
              })
            } catch (err: unknown) {
              jsonNoCors(res, { error: err instanceof Error ? err.message : 'Failed to start auth plugin flow' }, 500)
            }
          })
          .catch(() => jsonNoCors(res, { error: 'Invalid request body' }, 400))
        return
      }

      if (action === 'result' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        const session = pluginOAuthSessions.get(sessionId)
        if (!session || session.providerId !== provider) {
          json(res, { error: 'Auth session not found' }, 404)
          return
        }
        if (session.status === 'completed') {
          cleanupPluginOAuthSession(session)
          pluginOAuthSessions.delete(sessionId)
          json(res, { status: 'completed', saved: true })
          return
        }
        if (session.status === 'error') {
          cleanupPluginOAuthSession(session)
          pluginOAuthSessions.delete(sessionId)
          json(res, { status: 'error', error: session.error ?? 'Authentication failed' })
          return
        }
        json(res, { status: 'pending' })
        return
      }

      if (action === 'exchange' && req.method === 'POST') {
        readJsonBody<{ sessionId?: string; code?: string }>(req)
          .then(async (body) => {
            if (!plugin.exchangeCode) {
              jsonNoCors(res, { error: `Provider "${provider}" does not support code exchange` }, 400)
              return
            }
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            const code = typeof body.code === 'string' ? body.code.trim() : ''
            if (!sessionId || !code) {
              jsonNoCors(res, { error: 'sessionId and code are required' }, 400)
              return
            }
            const session = pluginOAuthSessions.get(sessionId)
            if (!session || session.providerId !== provider) {
              jsonNoCors(res, { error: 'Auth session not found' }, 404)
              return
            }
            if (session.status !== 'pending') {
              jsonNoCors(res, { error: 'Auth session is no longer pending' }, 409)
              return
            }

            try {
              const tokens = await plugin.exchangeCode({
                code,
                sessionState: session.sessionState,
              })
              const conflict = await withCredentialLock(async () => {
                if (await credentialConflictAt(session.configName, session.providerId)) return true
                await writeDashboardAuth(session.configName, {
                  type: 'oauth',
                  provider: session.credentialProviderId,
                  tokens,
                })
                return false
              })
              if (conflict) {
                session.status = 'error'
                session.error = CREDENTIAL_PROVIDER_CONFLICT.message
                cleanupPluginOAuthSession(session)
                pluginOAuthSessions.delete(sessionId)
                jsonNoCors(res, credentialRefusalBody(CREDENTIAL_PROVIDER_CONFLICT), CREDENTIAL_PROVIDER_CONFLICT.status)
                return
              }
              session.status = 'completed'
              cleanupPluginOAuthSession(session)
              pluginOAuthSessions.delete(sessionId)
              jsonNoCors(res, { status: 'completed', saved: true })
            } catch (err: unknown) {
              session.status = 'error'
              session.error = err instanceof Error ? err.message : 'Token exchange failed'
              cleanupPluginOAuthSession(session)
              pluginOAuthSessions.delete(sessionId)
              jsonNoCors(res, { error: session.error }, 500)
            }
          })
          .catch(() => jsonNoCors(res, { error: 'Invalid request body' }, 400))
        return
      }

      json(res, { error: 'Auth plugin route not found' }, 404)
      return
    }

    // POST /api/auth/credential — store typed credentials from dashboard
    if (path === '/api/auth/credential' && req.method === 'POST') {
      if (refuseCrossSiteRequest(req) !== undefined) {
        jsonNoCors(res, { error: 'cross_site_refused' }, 403)
        return
      }
      readJsonBody<{
        configName?: string
        provider?: string
        type?: string
        secret?: string
      }>(req)
        .then(async (body) => {
          const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
          const credentialType = typeof body.type === 'string' ? body.type.trim() : ''
          const secret = typeof body.secret === 'string' ? body.secret.trim() : ''

          if (typeof body.configName !== 'string' || body.configName.trim() === '') {
            jsonNoCors(res, { error: 'configName is required' }, 400)
            return
          }
          if (!provider || !isKnownLLMProvider(provider)) {
            jsonNoCors(res, { error: 'valid provider is required' }, 400)
            return
          }
          if (credentialType !== 'api-key' && credentialType !== 'bearer-token') {
            jsonNoCors(res, { error: 'type must be api-key or bearer-token' }, 400)
            return
          }
          if (!secret) {
            jsonNoCors(res, { error: 'secret is required' }, 400)
            return
          }

          if (getLLMAuthProviderPlugin(provider)) {
            jsonNoCors(res, { error: 'Subscription providers use OAuth login' }, 400)
            return
          }

          if (credentialType === 'bearer-token' && provider !== 'anthropic-compatible') {
            jsonNoCors(res, { error: 'bearer-token credentials are only supported for anthropic-compatible configs' }, 400)
            return
          }

          if (credentialType === 'api-key' && !API_KEY_CREDENTIAL_PROVIDERS.has(provider)) {
            jsonNoCors(res, { error: 'api-key credentials are not supported for this provider' }, 400)
            return
          }

          try {
            const target = await withCredentialLock(async () => {
              const checked = await requireCredentialConfig(configManager, body.configName, provider)
              if (!checked.ok) return checked
              if (credentialType === 'bearer-token') {
                await writeDashboardAuth(checked.configName, { type: 'bearer', provider, token: secret })
              } else {
                await writeDashboardAuth(checked.configName, { type: 'api', provider, key: secret })
              }
              return checked
            })
            if (!target.ok) {
              jsonNoCors(res, credentialRefusalBody(target), target.status)
              return
            }
            jsonNoCors(res, { saved: true, created: target.created })
          } catch (err: unknown) {
            jsonNoCors(res, { error: err instanceof Error ? err.message : 'Failed to save credential' }, 500)
          }
        })
        .catch(() => jsonNoCors(res, { error: 'Invalid request body' }, 400))
      return
    }

    // POST /api/auth/credential/move — 429-09 D-15: a draft's credential follows its name while the
    // name is still editable. Only between names that are not in registry.llms, and never onto a
    // name that already holds a credential.
    if (path === '/api/auth/credential/move' && req.method === 'POST') {
      if (refuseCrossSiteRequest(req) !== undefined) {
        jsonNoCors(res, { error: 'cross_site_refused' }, 403)
        return
      }
      readJsonBody<unknown>(req)
        .then(async (raw) => {
          const parsed = LlmCredentialMoveRequestSchema.safeParse(raw)
          if (!parsed.success) {
            jsonNoCors(res, { error: 'invalid_setup_input' }, 400)
            return
          }
          const from = checkCredentialName(parsed.data.from)
          const to = checkCredentialName(parsed.data.to)
          if (!from.ok || !to.ok) {
            jsonNoCors(res, { error: 'name_invalid' }, 400)
            return
          }
          if (!configManager) {
            jsonNoCors(res, { error: 'Config manager is required to move credentials' }, 400)
            return
          }
          try {
            const refusal = await withCredentialLock(async (): Promise<{ status: number; error: string; message?: string } | undefined> => {
              if (await findRegistryLlm(configManager, from.name) || await findRegistryLlm(configManager, to.name)) {
                return { status: 409, error: 'name_taken' }
              }
              const store = await readAuth() as Record<string, DashboardAuthCredential | undefined>
              const entry = ownAuthEntry(store, from.name)
              if (!entry) return { status: 404, error: 'credential_missing' }
              if (credentialProductProvider(from.name, entry) !== parsed.data.provider) return CREDENTIAL_PROVIDER_CONFLICT
              if (ownAuthEntry(store, to.name)) return { status: 409, error: 'credential_exists' }
              await writeDashboardAuth(to.name, entry)
              await removeAuth(from.name)
              return undefined
            })
            if (refusal) {
              jsonNoCors(res, credentialRefusalBody(refusal), refusal.status)
              return
            }
            jsonNoCors(res, { moved: true })
          } catch (err: unknown) {
            jsonNoCors(res, { error: err instanceof Error ? err.message : 'Failed to move credential' }, 500)
          }
        })
        .catch(() => jsonNoCors(res, { error: 'invalid_setup_input' }, 400))
      return
    }

    // POST /api/llm/test — test LLM connection
    // Same-site only and no wildcard grant on any answer: this arm spends a saved credential
    // against a provider, so a page on another origin must not be able to drive it.
    if (path === '/api/llm/test' && req.method === 'POST') {
      if (refuseCrossSiteRequest(req) !== undefined) {
        jsonNoCors(res, { error: 'cross_site_refused' }, 403)
        return
      }
      readJsonBody<{
        configName?: string
        provider?: string
        model?: string
        baseURL?: string
        providerHeaders?: Record<string, string>
      }>(req)
        .then(async (body) => {
          const rawBody = body as Record<string, unknown>
          if ('apiKey' in rawBody) {
            jsonNoCors(res, {
              success: false,
              error: 'invalid_request',
              message: 'apiKey is not accepted in LLM test requests. Save credentials for the named config instead.',
            }, 400)
            return
          }
          const providerName = typeof body.provider === 'string' ? body.provider.trim() : ''
          const modelName = typeof body.model === 'string' ? body.model.trim() : ''
          if (!providerName || !modelName) {
            jsonNoCors(res, { success: false, error: 'invalid_request', message: 'provider and model are required' }, 400)
            return
          }
          const configName = typeof body.configName === 'string' ? body.configName.trim() : ''

          const llmCandidate: Record<string, unknown> = {
            provider: providerName,
            model: modelName,
          }
          if (typeof body.baseURL === 'string') {
            llmCandidate.baseURL = body.baseURL
          }
          let savedHeaderValues: string[] = []
          const bodyHeaders: unknown = body.providerHeaders
          const headerRecord = bodyHeaders !== null
            && typeof bodyHeaders === 'object'
            && !Array.isArray(bodyHeaders)
          if (bodyHeaders === undefined || headerRecord) {
            const baseURL = trimmedString(body.baseURL)
            const saved = await savedHeadersFor(configManager, configName, providerName, baseURL)
            const merged = mergeTestHeaders(saved, (bodyHeaders ?? {}) as Record<string, unknown>)
            savedHeaderValues = merged.savedValues
            if (Object.keys(merged.headers).length > 0) llmCandidate.providerHeaders = merged.headers
          } else {
            llmCandidate.providerHeaders = bodyHeaders
          }

          const parsedConfig = ModelConfigSchema.safeParse(llmCandidate)
          if (!parsedConfig.success) {
            jsonNoCors(res, {
              success: false,
              error: 'invalid_request',
              message: parsedConfig.error.issues
                .map((issue: { path: PropertyKey[]; message: string }) => `${issue.path.map(String).join('.') || 'config'}: ${issue.message}`)
                .join('; '),
            }, 400)
            return
          }

          const start = Date.now()
          const llmConfig = parsedConfig.data
          const coreAuth = await import('@vostride/agent-qa-core') as typeof import('@vostride/agent-qa-core') & {
            resolveLLMAuth: (name: string, config: typeof llmConfig) => Promise<
              | { kind: 'api-key'; apiKey: string }
              | { kind: 'bearer-token'; token: string }
              | { kind: 'auth-fetch'; fetch: typeof globalThis.fetch; modelAdapter: 'openai-responses' | 'anthropic-messages' }
              | { kind: 'unauthenticated'; message: string }
              | { kind: 'missing'; message: string }
            >
          }
          const resolvedAuth = await coreAuth.resolveLLMAuth(configName, llmConfig)
          if (resolvedAuth.kind === 'missing') {
            jsonNoCors(res, {
              success: false,
              error: 'missing_credential',
              message: resolvedAuth.message,
            })
            return
          }

          let unauthenticated = false
          let authMessage: string | undefined
          if (resolvedAuth.kind === 'unauthenticated') {
            unauthenticated = true
            authMessage = resolvedAuth.message
          }

          try {
            const { profile, auth } = toModelProfileAndAuth(llmConfig, resolvedAuth)
            // 2026-10-12 (441-04, D-06): fixed probe text, nothing to mask.
            const model = createModel(profile, auth, (text) => text)
            const connectionTimeoutMs = llmConnectionTestTimeoutMs(llmConfig)

            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), connectionTimeoutMs)
            try {
              const { generateText } = await import('ai')
              await generateText({
                model,
                prompt: 'Say "ok"',
                abortSignal: controller.signal,
              })
            } finally {
              clearTimeout(timeout)
            }

            jsonNoCors(res, {
              success: true,
              model: modelName,
              provider: providerName,
              timeoutMs: connectionTimeoutMs,
              responseTime: Date.now() - start,
              ...(unauthenticated ? { unauthenticated: true, message: authMessage } : {}),
            })
          } catch (err: unknown) {
            const connectionTimeoutMs = llmConnectionTestTimeoutMs(llmConfig)
            const { message: rawProviderMessage, statusCode } = extractProviderError(err)
            const unsavedMessage = withoutSavedValues(rawProviderMessage, savedHeaderValues)
            const providerMessage = withDeclaredMask(declaredMask, (mask) => mask(unsavedMessage))
            const errorClass = classifyProviderError(providerMessage ?? unsavedMessage, statusCode)
            const message = providerMessage === undefined
              ? providerErrorSentence(errorClass, '').trimEnd()
              : providerErrorSentence(errorClass, providerMessage)

            jsonNoCors(res, {
              success: false,
              error: errorClass,
              message,
              timeoutMs: connectionTimeoutMs,
              ...(statusCode ? { statusCode } : {}),
              ...(providerMessage !== undefined && message !== providerMessage ? { details: providerMessage } : {}),
              ...(unauthenticated ? { unauthenticated: true, authMessage } : {}),
            })
          }
        })
        .catch(() => jsonNoCors(res, { success: false, error: 'invalid_request', message: 'Invalid request body' }, 400))
      return
    }

    // POST /api/cache/purge — clears every cached plan
    if (path === '/api/cache/purge' && req.method === 'POST') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 503)
        return
      }
      readJsonBody<{ all?: boolean }>(req)
        .then(async (body) => {
          if (body.all !== true) {
            json(res, { error: 'all is required' }, 400)
            return
          }
          try {
            const cfg = (await readConfigValues(configManager)) as {
              services?: { cache?: { dir?: string } }
            }
            const configDir = deps.configPath ? dirname(resolve(deps.configPath)) : process.cwd()
            const cacheDir = cfg.services?.cache?.dir ?? DEFAULT_AGENT_QA_CACHE_DIR
            const purged = await purgeActionCache(resolve(configDir, cacheDir))
            json(res, { purged })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Cache purge failed' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // Agent Rules API removed: the workspace agent-rules config surface was retired in
    // Phase 373 (KDIR-03); policy serving returns via Reader L0 policies in Phase 380.

    // Hooks API
    if (path === '/api/hooks' && req.method === 'GET') {
      const hookRegistryManager = createHookRegistryManager(configManager, deps.configPath)
      if (!hookRegistryManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          json(res, await hookRegistryManager.readCatalog())
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read hooks' }, 500)
        }
      })()
      return
    }

    if (path === '/api/hooks' && req.method === 'POST') {
      const hookRegistryManager = createHookRegistryManager(configManager, deps.configPath)
      if (!hookRegistryManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody(req)
        .then(async (body) => {
          try {
            const result = await hookRegistryManager.createHook(body as import('../hooks/hook-registry-types.js').HookMutationRequest)
            json(res, result, 201)
          } catch (err: unknown) {
            if (isHookRegistryMutationError(err) && err.code === 'validation_failed') {
              json(res, { error: 'validation_failed', fieldErrors: err.fieldErrors }, 400)
              return
            }
            json(res, { error: err instanceof Error ? err.message : 'Failed to create hook' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    const hookRunMatch = path.match(/^\/api\/hooks\/([^/]+)\/run$/)
    if (hookRunMatch && req.method === 'POST') {
      const hookRegistryManager = createHookRegistryManager(configManager, deps.configPath)
      if (!hookRegistryManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<import('../hooks/hook-registry-types.js').HookRunRequest>(req)
        .then(async (body) => {
          try {
            const validation = validateHookRunRequest(body)
            if (validation.fieldErrors.length > 0) {
              json(res, { error: 'validation_failed', fieldErrors: validation.fieldErrors }, 400)
              return
            }

            const hookId = decodeURIComponent(hookRunMatch[1])
            const prepareResult = await hookRegistryManager.prepareForExecution()
            if (prepareResult.hookRegistryError) {
              json(res, { error: 'hook_registry_error', message: prepareResult.hookRegistryError }, 409)
              return
            }

            const resolvedHook = prepareResult.resolvedHooks.get(hookId)
            if (!resolvedHook) {
              const detail = await hookRegistryManager.readHook(hookId)
              if (!detail) {
                notFound(res, 'Hook not found')
                return
              }

              const fieldErrors = prepareResult.authoringIssuesById.get(hookId) ?? detail.fieldErrors
              if (fieldErrors.length > 0) {
                json(res, { error: 'hook_not_runnable', fieldErrors }, 409)
                return
              }

              json(res, { error: 'hook_not_runnable', message: 'Hook is not executable' }, 409)
              return
            }

            if (declaredMask === undefined) {
              json(res, { error: 'masking_unavailable' }, 503)
              return
            }
            const workspaceEnv = await readWorkspaceEnvVars(workspacePaths)
            const result = await new DockerHookExecutor({ version: getAgentQaVersion() }).execute(resolvedHook, {
              env: {
                ...workspaceEnv,
                ...validation.overrides,
              },
              secretEnv: {},
            })
            const networkLogs = summarizeHookNetworkLogs(
              (result as { networkLogs?: Array<{ url: string; method: string; status: number; startTime: number; endTime: number }> }).networkLogs,
            )
            const shown = withDeclaredMask(declaredMask, (mask) => ({
              ...maskPayloadStrings({
                output: result.output,
                stdout: result.stdout,
                stderr: result.stderr,
                error: result.error ?? null,
              }, mask),
              variables: maskPayloadTree(result.variables, mask),
              networkLogs: networkLogs.map((entry) => ({ ...entry, url: mask(entry.url) })),
            }))
            if (shown === undefined) {
              json(res, { error: 'masking_unavailable' }, 503)
              return
            }

            json(res, {
              success: result.success,
              status: result.success ? 'passed' : 'failed',
              executedAt: new Date().toISOString(),
              duration: result.duration,
              output: shown.output,
              stdout: shown.stdout,
              stderr: shown.stderr,
              error: shown.error,
              variables: shown.variables,
              sandbox: {
                runtime: resolvedHook.runtime,
                image: hookRunnerImage(resolvedHook.runtime, getAgentQaVersion()),
                networkMode: resolvedHook.network ? 'enabled' : 'disabled',
                dockerVersion: null,
                networkLogsAvailable: shown.networkLogs.length > 0,
                networkLogs: shown.networkLogs,
              },
            } satisfies import('../hooks/hook-registry-types.js').HookRunResponse)
          } catch (err: unknown) {
            const message = err instanceof Error
              ? withDeclaredMask(declaredMask, (mask) => mask(err.message))
              : undefined
            json(res, { error: message ?? 'Failed to run hook' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    const hookDetailMatch = path.match(/^\/api\/hooks\/([^/]+)$/)
    if (hookDetailMatch && req.method === 'GET') {
      const hookRegistryManager = createHookRegistryManager(configManager, deps.configPath)
      if (!hookRegistryManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const detail = await hookRegistryManager.readHook(decodeURIComponent(hookDetailMatch[1]))
          if (!detail) {
            notFound(res, 'Hook not found')
            return
          }
          json(res, detail)
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read hook' }, 500)
        }
      })()
      return
    }

    if (hookDetailMatch && req.method === 'PUT') {
      const hookRegistryManager = createHookRegistryManager(configManager, deps.configPath)
      if (!hookRegistryManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody(req)
        .then(async (body) => {
          try {
            const result = await hookRegistryManager.updateHook(
              decodeURIComponent(hookDetailMatch[1]),
              body as import('../hooks/hook-registry-types.js').HookMutationRequest,
            )
            json(res, result)
          } catch (err: unknown) {
            if (isHookRegistryMutationError(err) && err.code === 'hook_not_found') {
              notFound(res, 'Hook not found')
              return
            }
            if (isHookRegistryMutationError(err) && err.code === 'validation_failed') {
              json(res, { error: 'validation_failed', fieldErrors: err.fieldErrors }, 400)
              return
            }
            json(res, { error: err instanceof Error ? err.message : 'Failed to update hook' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    if (hookDetailMatch && req.method === 'DELETE') {
      const hookRegistryManager = createHookRegistryManager(configManager, deps.configPath)
      if (!hookRegistryManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const result = await hookRegistryManager.deleteHook(
            decodeURIComponent(hookDetailMatch[1]),
            { force: url.searchParams.get('force') === 'true' },
          )
          if (!result.deleted) {
            json(res, { error: 'hook_in_use', references: result.references }, 409)
            return
          }
          json(res, result)
        } catch (err: unknown) {
          if (isHookRegistryMutationError(err) && err.code === 'hook_not_found') {
            notFound(res, 'Hook not found')
            return
          }
          if (isHookRegistryMutationError(err) && err.code === 'validation_failed') {
            json(res, { error: 'validation_failed', fieldErrors: err.fieldErrors }, 400)
            return
          }
          json(res, { error: err instanceof Error ? err.message : 'Failed to delete hook' }, 500)
        }
      })()
      return
    }

    // Variables API
    if (path === '/api/variables' && req.method === 'GET') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          if (!workspacePaths) {
            json(res, { error: 'Workspace path resolution not available' }, 503)
            return
          }
          let content: string
          try {
            content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              json(res, { error: `workspace.envFile not found: ${workspacePaths.envFile.workspaceRelativePath}` }, 500)
              return
            }
            throw err
          }
          const parsed = parseEnvFile(content)
          const variables = Object.entries(parsed).map(([key, value]) => ({ key, value }))
          json(res, { variables, filePath: workspacePaths.envFile.workspaceRelativePath })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read variables' }, 500)
        }
      })()
      return
    }

    if (path === '/api/variables' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<{ oldKey?: string; key: string; value: string }>(req)
        .then(async (body) => {
          try {
            if (!body.key || typeof body.key !== 'string') {
              json(res, { error: 'Missing required field: key' }, 400)
              return
            }
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.key)) {
              json(res, { error: 'Variable names must contain only letters, numbers, and underscores' }, 400)
              return
            }
            if (!workspacePaths) {
              json(res, { error: 'Workspace path resolution not available' }, 503)
              return
            }
            let content = ''
            try {
              content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                json(res, { error: `workspace.envFile not found: ${workspacePaths.envFile.workspaceRelativePath}` }, 500)
                return
              }
              throw err
            }
            const vars = parseEnvFile(content)
            if (body.oldKey && body.oldKey !== body.key) {
              delete vars[body.oldKey]
            }
            vars[body.key] = body.value ?? ''
            await writeFile(workspacePaths.envFile.absolutePath, serializeEnvFile(vars), 'utf-8')
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update variable' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    const varDeleteMatch = path.match(/^\/api\/variables\/(.+)$/)
    if (varDeleteMatch && req.method === 'DELETE') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const varKey = decodeURIComponent(varDeleteMatch[1])
          if (!workspacePaths) {
            json(res, { error: 'Workspace path resolution not available' }, 503)
            return
          }
          let content = ''
          try {
            content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              json(res, { error: `workspace.envFile not found: ${workspacePaths.envFile.workspaceRelativePath}` }, 500)
              return
            }
            throw err
          }
          const vars = parseEnvFile(content)
          const existed = varKey in vars
          delete vars[varKey]
          await writeFile(workspacePaths.envFile.absolutePath, serializeEnvFile(vars), 'utf-8')
          json(res, { deleted: existed })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to delete variable' }, 500)
        }
      })()
      return
    }

    // GET /api/live-editor/sessions/:id/live-url — the editor mint door (428 D-07).
    //
    // A copy of the run mint door above, arm for arm: the same-site guard first, 503 when unbound,
    // the op's result verbatim and its refusals mapped by error name. Every arm answers through
    // `jsonNoCors`, because the success body is the token. The DELETE arm below matches one path
    // segment after the id, so it never sees a `/live-url` suffix.
    if (req.method === 'GET' && /^\/api\/live-editor\/sessions\/[^/]+\/live-url$/.test(path)) {
      if (refuseCrossSiteRequest(req) !== undefined) {
        jsonNoCors(res, { error: 'cross_site_refused' }, 403)
        return
      }
      if (!deps.mintEditorLiveUrl) {
        jsonNoCors(res, { error: 'live_view_unavailable' }, 503)
        return
      }
      let editorSessionId: string
      try {
        editorSessionId = decodeURIComponent(
          path.slice('/api/live-editor/sessions/'.length, -'/live-url'.length),
        )
      } catch {
        jsonNoCors(res, { error: 'unknown_session' }, 404)
        return
      }
      void deps.mintEditorLiveUrl(editorSessionId).then(
        (result) => { jsonNoCors(res, result) },
        (error: unknown) => {
          const name = error instanceof Error ? error.name : ''
          if (name === 'UnknownLiveEditorSessionError') { jsonNoCors(res, { error: 'unknown_session' }, 404); return }
          if (name === 'LiveViewUnavailableError') { jsonNoCors(res, { error: 'live_view_unavailable' }, 503); return }
          jsonNoCors(res, { error: 'live_url_mint_failed' }, 500)
        },
      )
      return
    }

    // THE LIVE-EDITOR DOORS (428 D-08 — WINDOWS #275). These four arms create, list, end and read
    // auth state out of sessions that drive a real browser, which is more than the live-url grants.
    // Each runs the one same-site predicate first and answers every arm, success and refusal alike,
    // through `jsonNoCors`: a wildcard grant on an admitted answer would leave a readable session
    // list behind for any origin (RESEARCH P6). The rest of this router keeps its posture.
    // POST /api/live-editor/sessions/:id/auth-state — save auth state from active web Live Mode context
    const liveEditorAuthStateMatch = path.match(/^\/api\/live-editor\/sessions\/([^/]+)\/auth-state$/)
    if (liveEditorAuthStateMatch && req.method === 'POST') {
      // 428 D-08 (WINDOWS #275): the same-site guard first, and no wildcard grant on any answer.
      if (refuseCrossSiteDisplayRead(req, res)) return
      if (!sessionManager) {
        jsonNoCors(res, { error: 'Live editor not available' }, 503)
        return
      }
      ;(async () => {
        let stateName = ''
        let session: { captureWebAuthState?: (name: string, options: { replace: boolean }) => Promise<unknown>; getState?: () => unknown } | undefined
        try {
          const body = await readJsonBody<{ name?: unknown; replace?: unknown }>(req)
          const parsedName = AuthStateNameSchema.safeParse(typeof body?.name === 'string' ? body.name : '')
          if (!parsedName.success) {
            jsonNoCors(res, { error: 'Auth state name must be a lowercase slug.' }, 400)
            return
          }

          stateName = parsedName.data
          session = sessionManager.getSession(decodeURIComponent(liveEditorAuthStateMatch[1]))
          if (!session) {
            jsonNoCors(res, { error: 'Session not found' }, 404)
            return
          }

          if (typeof session.captureWebAuthState !== 'function') {
            jsonNoCors(res, {
              error: `Could not save auth state "${stateName}" for target "${getSessionTargetNameForAuthState(session)}".`,
            }, 500)
            return
          }

          const authState = await session.captureWebAuthState(stateName, { replace: body?.replace === true })
          jsonNoCors(res, { authState })
        } catch (err: unknown) {
          const targetName = getSessionTargetNameForAuthState(session)
          const response = buildAuthStateSaveErrorMessage(stateName || 'unknown', targetName, err)
          jsonNoCors(res, { error: response.message }, response.status)
        }
      })()
      return
    }

    // POST /api/live-editor/sessions — create a new live editor session
    if (path === '/api/live-editor/sessions' && req.method === 'POST') {
      // 428 D-08 (WINDOWS #275): the same-site guard first, and no wildcard grant on any answer.
      if (refuseCrossSiteDisplayRead(req, res)) return
      if (!sessionManager) {
        jsonNoCors(res, { error: 'Live editor not available' }, 503)
        return
      }
      ;(async () => {
        try {
          const body = await readJsonBody<{
            platform?: string
            targetName?: string
            url?: string
            headless?: boolean
            device?: Record<string, unknown>
            useDeviceName?: string
            appState?: string
            bundleId?: string
            appPackage?: string
            appActivity?: string
            setupHooks?: unknown
            teardownHooks?: unknown
            entity?: { type?: string; id?: string }
          }>(req)
          const targetName = typeof body?.targetName === 'string' ? body.targetName : undefined
          const platform = body?.platform ?? 'web'
          const runtimeLLM = await resolveDashboardRuntimeLLM(configManager, llmConfig, authFetch)
          if (!runtimeLLM.ok) {
            jsonNoCors(res, { error: runtimeLLM.error }, 400)
            return
          }
          const setupHooks = Array.isArray(body?.setupHooks)
            ? body.setupHooks.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : []
          const teardownHooks = Array.isArray(body?.teardownHooks)
            ? body.teardownHooks.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : []
          // Validate entity (ASVS V5). Only 'suite' | 'test' with a non-empty id
          // are honoured; malformed shapes are silently ignored — client may
          // send {} during the test-editor retrofit before entity threading
          // lands (downgrades to sessionNumber=null instead of a 400 error).
          let entityRef: { type: 'suite' | 'test'; id: string } | undefined
          if (body?.entity && typeof body.entity === 'object') {
            const t = body.entity.type
            const id = body.entity.id
            if ((t === 'suite' || t === 'test') && typeof id === 'string' && id.length > 0) {
              entityRef = { type: t, id }
            }
          }
          let envVars: Record<string, string> | undefined
          let secretStore: SecretStore | undefined
          let secretRedactor: SecretRedactor | undefined
          let resolvedHooks = new Map<string, import('@vostride/agent-qa-core').HookDefinition>()
          let hookRegistryError: string | undefined
          if (!workspacePaths) {
            jsonNoCors(res, { error: 'Workspace path resolution not available' }, 500)
            return
          }

          try {
            const envContent = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
            envVars = parseEnvFile(envContent)
          } catch {
            jsonNoCors(res, { error: `workspace.envFile file could not be loaded: ${workspacePaths.envFile.workspaceRelativePath}` }, 400)
            return
          }

          try {
            const secretsContent = await readFile(workspacePaths.secretsFile.absolutePath, 'utf-8')
            secretStore = SecretStore.fromEnvContent(secretsContent)
            secretRedactor = new SecretRedactor(secretStore)
          } catch {
            jsonNoCors(res, { error: `workspace.secretsFile file could not be loaded: ${workspacePaths.secretsFile.workspaceRelativePath}` }, 400)
            return
          }

          const hookCatalog = await readWorkspaceHooks(configManager, deps.configPath)
          resolvedHooks = hookCatalog.resolvedHooks
          hookRegistryError = hookCatalog.hookRegistryError
          // 436 D-03: the limits come from the project config and the edited entity's own `use`,
          // read through the workspace managers by canonical id; never from the request.
          const entityReaders = {
            ...(testFileManager === undefined ? {} : { findTest: (id: string) => testFileManager.findByTestId(id) }),
            ...(suiteFileManager === undefined ? {} : { findSuite: (id: string) => suiteFileManager.findBySuiteId(id) }),
          }
          const plannerLimits = await resolveLivePlannerLimits(configManager, entityRef, entityReaders)
          const navigationTimeoutMs = await resolveLiveNavigationTimeoutMs(
            configManager,
            entityRef,
            entityReaders,
          )
          // Each test a session runs gets project, then the session's suite, then its own `use`:
          // the chain the CLI suite producer resolves per member.
          const sessionSuiteRef = entityRef?.type === 'suite' ? entityRef : undefined
          const plannerLimitsForTest = (testId: string) =>
            resolveLivePlannerLimits(
              configManager,
              sessionSuiteRef === undefined
                ? [{ type: 'test', id: testId }]
                : [sessionSuiteRef, { type: 'test', id: testId }],
              entityReaders,
            )
          const { sessionId, sessionNumber } = await sessionManager.createSession(
            {
              platform: platform as 'web' | 'android' | 'ios',
              targetName,
              plannerLimits,
              plannerLimitsForTest,
              llmConfig: runtimeLLM.llmConfig,
              authFetch: runtimeLLM.authFetch,
              envVars,
              secretStore,
              secretRedactor,
              setupHooks,
              teardownHooks,
              resolvedHooks,
              hookRegistryError,
              url: body?.url,
              headless: body?.headless ?? false,
              navigationTimeoutMs,
              useDeviceName: typeof body?.useDeviceName === 'string' ? body.useDeviceName : undefined,
              appState: body?.appState === 'preserve' || body?.appState === 'reset' ? body.appState : undefined,
              bundleId: typeof body?.bundleId === 'string' ? body.bundleId : undefined,
              appPackage: typeof body?.appPackage === 'string' ? body.appPackage : undefined,
              appActivity: typeof body?.appActivity === 'string' ? body.appActivity : undefined,
              device: body?.device as import('../live-editor/types.js').LiveSessionConfig['device'],
            },
            entityRef,
          )
          jsonNoCors(res, { sessionId, sessionNumber }, 201)
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          // A planner limit or navigation timeout the CLI refuses is refused here, before any
          // session exists.
          const refused =
            err instanceof LivePlannerLimitsRefusedError ||
            err instanceof LiveNavigationTimeoutRefusedError
          const status = refused ? 400 : 500
          jsonNoCors(res, { error: message }, status)
        }
      })()
      return
    }

    // GET /api/live-editor/sessions — list all active live editor sessions
    if (path === '/api/live-editor/sessions' && req.method === 'GET') {
      // 428 D-08 (WINDOWS #275): the same-site guard first, and no wildcard grant on any answer.
      if (refuseCrossSiteDisplayRead(req, res)) return
      if (!sessionManager) {
        jsonNoCors(res, { error: 'Live editor not available' }, 503)
        return
      }
      jsonNoCors(res, { sessions: sessionManager.listSessions() })
      return
    }

    // DELETE /api/live-editor/sessions/:id — terminate a live editor session
    const liveEditorSessionMatch = path.match(/^\/api\/live-editor\/sessions\/([^/]+)$/)
    if (liveEditorSessionMatch && req.method === 'DELETE') {
      // 428 D-08 (WINDOWS #275): the same-site guard first, and no wildcard grant on any answer.
      if (refuseCrossSiteDisplayRead(req, res)) return
      if (!sessionManager) {
        jsonNoCors(res, { error: 'Live editor not available' }, 503)
        return
      }
      const sessionId = liveEditorSessionMatch[1]
      ;(async () => {
        const terminated = await sessionManager.terminateSession(sessionId)
        if (terminated) {
          jsonNoCors(res, { ok: true })
        } else {
          jsonNoCors(res, { error: 'Session not found' }, 404)
        }
      })()
      return
    }

    // Variable suggestions: env keys
    if (path === '/api/variables/env' && req.method === 'GET') {
      if (!configManager) {
        json(res, { keys: [] })
        return
      }
      ;(async () => {
        try {
          if (!workspacePaths) {
            json(res, { error: 'Workspace path resolution not available' }, 503)
            return
          }
          const content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
          const parsed = parseEnvFile(content)
          json(res, { keys: Object.keys(parsed) })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read env variables' }, 500)
        }
      })()
      return
    }

    // Variable suggestions: hook names
    if (path === '/api/variables/hooks' && req.method === 'GET') {
      ;(async () => {
        try {
          const { hooks } = await readWorkspaceHooks(configManager, deps.configPath)
          json(res, { names: hooks.map((hook) => hook.name) })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read hooks' }, 500)
        }
      })()
      return
    }

    // 2026-08-27 (405-07, D-02): the captured-variable-name suggestion arm was deleted with its
    // reader. It scanned a `captured_variables` column on the v1 projection, which no producer has
    // filled since the subscriber was rebuilt on the bus payloads — so the endpoint answered an
    // empty list on every real workspace while looking like a working suggestion source. The hook
    // and workspace suggestion arms above are unaffected: their producers are live.

    // Unknown API route
    if (path.startsWith('/api/')) {
      notFound(res)
      return
    }

    // Non-API routes handled by server.ts (static files)
    notFound(res)
  }
}
