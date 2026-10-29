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
import { carriesNonJsonBody, readJsonBody } from './body-parser.js'
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
// The post-processing read and its live channel; both arms sit above the `/api/runs/:id` catch-all.
import {
  servePostProcessingRead,
  servePostProcessingStream,
} from '../run-service/post-processing-routes.js'
// Refs and run detail: both arms sit above the `/api/runs/:id` catch-all and open no store.
import {
  serveRunArtifact,
  serveRunDetailRead,
  serveRunEvidenceRead,
  serveRunMarkPreviewRead,
  serveRunMarksHistoryRead,
} from '../run-service/run-detail-routes.js'
// The failure view's read; its arm sits above the `/api/runs/:id` catch-all.
import { serveRunAnalysisRead } from '../run-service/run-analysis-routes.js'
// The Knowledge panel's read; its arm sits above the `/api/runs/:id` catch-all.
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

// `auth.json` is machine-wide and keyed by name, so every name passes core's name rule first.
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

// Saved header values are read on the server, only for the saved model's endpoint.
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

// Undefined when no declared mask is bound or it throws, so a caller leaves the text out.
function withDeclaredMask<T>(mask: MaskFn | undefined, build: (mask: MaskFn) => T): T | undefined {
  if (mask === undefined) return undefined
  try {
    return build(mask)
  } catch {
    return undefined
  }
}

// The target list answers masked names, so a save whose target holds one writes the marker.
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

// One queue per router, so writes to the machine-wide `auth.json` never interleave.
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

/** No answer carries a cross-origin grant. */
function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
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

// Only runs whose curation finished or is skipped are read; the rest are counted apart.
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

// A list row's rate is its viewer's own fold of pass and pass-or-fail counts.
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

// A suite row's target and platform come from its newest run with a target, else its last run.
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
  // `JobQueue.enqueue` also copies metadata into the artifact payload, so it gets the allowlist.
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

// Empty: the server writes every metadata key, and a caller's own labels go through `attributes`.
export const CLIENT_WRITABLE_QUEUED_RUN_METADATA_KEYS: ReadonlySet<string> = new Set<string>([])

// Server-written keys; `confirmScope` stays because an older row can still hold it.
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

// An unusable value falls back to the backend's default, never a clamped number.
export function sanitizeQueuedExecutionTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value <= 0 || value > MAX_QUEUED_EXECUTION_TIMEOUT_MS) return undefined
  return value
}

// An allowlist fails closed, so a key nobody has invented yet never leaves in a response.
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

// The read-path counterpart of `sanitizeQueuedRunMetadata`; `null` and absence pass unchanged.
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

// The same allowlist at the payload's copy; `attributes` passes because the queue mints it.
function sanitizeArtifactPayloadMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata = payload.metadata
  if (!isRecord(metadata)) return payload
  const safe = sanitizeRunMetadataForResponse(metadata) ?? {}
  return {
    ...payload,
    metadata: 'attributes' in metadata ? { ...safe, attributes: metadata.attributes } : safe,
  }
}

// Exported so `routes.runs.test.ts` can compare it, by set equality, with the database's run reads.
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

// Run-named members that hand out no run metadata; construction throws on any name in neither set.
const RUN_READS_WITHOUT_ROWS: ReadonlySet<string> = new Set([
  // `readRunDetailRows` returns masked bus payloads and no run row, so it has no metadata to strip.
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
  // Run ids and a count, no row; each id is dispatched through the agent host.
  'listInsightsWindowRunIds',
  'insertPendingRun',
  'insertRun',
  'insertRunArtifact',
  'listRunAttributeKeys',
  'listRunAttributeValues',
  // An owner (pid, incarnation, host), no run metadata.
  'readRunOwner',
  // Ids and owners only, no run metadata.
  'listRunningRunOwners',
  // Compare-and-set writes that return a boolean.
  'finalizeOrphanRun',
  'finalizeOwnRun',
  // A compare-and-set write that returns a boolean, no run metadata.
  'closeOwnRun',
  // A compare-and-set write that returns a boolean, no run metadata.
  'claimRunningRow',
  'stageRunArtifact',
  'updateRun',
  'updateRunMetadata',
  'updateRunStatus',
])

// `private` is erased at emit, so private run-named helpers appear on the live prototype.
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

// Ranges the live object, so inherited or runtime-attached methods are seen too.
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

// One wrapper at the router covers every serializing door; an unlisted run read throws at build.
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
    // One artifact; `getRunArtifact` is the choke point for its payload, and this delegates to it.
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
  executionBackend?: ExecutionBackend
  jobQueue?: JobQueue
  testFileManager?: TestFileManager
  suiteFileManager?: SuiteFileManager
  configManager?: ConfigManager
  configPath?: string
  // Hook output, provider error text and target names leave through this mask.
  declaredSecretMask?: MaskFn

  llmConfig?: DashboardRuntimeLLMConfig
  authFetch?: typeof globalThis.fetch
  sessionManager?: import('../live-editor/session-manager.js').SessionManager
  // Optional: a router built as `createRouter(db)` has none, and its arms answer by name, not 404.
  agentHost?: AgentHost
  // The same readiness function the run service's `/ok` serves; absent only on a legacy mount.
  runServiceReadiness?: () => RunServiceReadiness
  // The authed door's attach port too, so both doors share one session registry; absent is a 503.
  runServiceAttach?: (runId: string) => RunSession | undefined
  // A function, not a signer; absent means no live view, and the route answers 503 by name.
  mintLiveUrl?: (runId: string, handle: number) => Promise<RunsLiveUrlResult>
  // The editor counterpart of `mintLiveUrl`; absent means no editor view, answered 503 by name.
  mintEditorLiveUrl?: (sessionId: string) => Promise<EditorLiveUrlResult>
  // Created by `agent-qa dashboard` so the CLI's emitter reaches it; absent, the stream is a 503.
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
  // The response layer reads run rows through the projection; the host and queue keep `deps.db`.
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
      json(res, { error: 'cross_site_refused' }, 403)
      return
    }
    if (carriesNonJsonBody(req)) {
      json(res, { error: 'unsupported_media_type' }, 415)
      return
    }
    const path = url.pathname

    // The field-merge config write.
    if (path === '/api/config' && req.method === 'PATCH') {
      if (!configManager) {
        json(res, { error: 'config_unavailable' }, 503)
        return
      }
      registerConfigWriteRoute(req, res, { configManager, undoStore })
      return
    }

    // The Undo door answers every method itself.
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

    // The cheap revision read the page polls to notice an outside edit.
    if (path === '/api/config/revision' && req.method === 'GET') {
      if (!configManager) {
        json(res, { error: 'config_unavailable' }, 503)
        return
      }
      registerConfigRevisionRoute(req, res, { configManager })
      return
    }

    // The draft connect transaction.
    if (path === '/api/llm/connect' && req.method === 'POST') {
      if (!configManager) {
        json(res, { error: 'config_unavailable' }, 503)
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
      const statuses = url.searchParams.getAll('status')
      const unknownStatus = statuses.find((word) => !isRunStatusWord(word))
      if (unknownStatus !== undefined) {
        json(res, { error: `Unknown run status: ${unknownStatus}.` }, 400)
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
          json(res, {
            runs,
            total: filtered.length,
            targets: targetOptions,
          })
        })
        .catch(() => json(res, { error: 'Failed to list runs' }, 500))
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
      const runId = decodeURIComponent(runArtifactMatch[1])
      const run = db.getRun(runId)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const bundle = db.getRunArtifactBundle(runId)
      json(res, {
        run,
        artifact: sanitizeArtifactForResponse(bundle.artifact),
        missingSections: getArtifactMissingSections(bundle.artifact),
      })
      return
    }

    // GET /api/runs/:id/execution-logs
    if (path.startsWith('/api/runs/') && path.endsWith('/execution-logs') && req.method === 'GET') {
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const stepId = url.searchParams.get('stepId') ?? undefined
      const type = url.searchParams.get('type') ?? undefined

      // A suite's hook logs are written against its one run id, with `test_index` and `step_index`.
      const logs = db.getExecutionLogs({ runId: id, stepId, type })
      json(res, { logs })
      return
    }

    // Registered before the run catch-all; no private feedback implementation here.
    if (path.startsWith('/api/runs/') && path.endsWith('/mark') && req.method === 'POST') {
      if (deps.agentHost === undefined) {
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, -'/mark'.length))
      } catch {
        json(res, { error: 'invalid_mark_input' }, 400)
        return
      }
      registerRunMarkRoute(req, res, { host: deps.agentHost, runId })
      return
    }

    // The read-tier consequence preview; the adapter guards, parses and dispatches the op.
    if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/mark-preview$/.test(path)) {
      if (deps.agentHost === undefined) {
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, -'/mark-preview'.length))
      } catch {
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      serveRunMarkPreviewRead(req, res, { runId, host: deps.agentHost })
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
      // Each answer in plain words; the route writes nothing.
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

        // Rows only: the event log and blobs under the run directory are the run's own record.
        json(res, { deleted: true, deletedRunIds: deletedRun.deletedRunIds })
      } catch {
        json(res, { error: 'Failed to delete run' }, 500)
      }
      return
    }

    // Above the `GET /api/runs/:id` arm, which claims every GET under the prefix.
    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/live-url$/.test(path)) {
      if (!deps.mintLiveUrl) {
        json(res, { error: 'live_view_unavailable' }, 503)
        return
      }
      let liveUrlRunId: string
      try {
        liveUrlRunId = decodeURIComponent(path.slice('/api/runs/'.length, -'/live-url'.length))
      } catch {
        json(res, { error: 'unknown_run' }, 404)
        return
      }
      // THE RAW `handle` PARAMETER THROUGH THE SCHEMA'S OWN READER, on the run-stream door's
      // reasoning one route up: `url.searchParams` resolves `?handle=1&handle=2` to `1`, which is
      // the one answer that reader exists to refuse.
      const rawHandle = handleParamOf(req)
      const parsedHandle = parseHandleParam(rawHandle)
      if (parsedHandle.kind === 'invalid') {
        json(res, { error: 'invalid_handle' }, 400)
        return
      }
      const handle = parsedHandle.kind === 'absent' ? 0 : parsedHandle.index
      void deps.mintLiveUrl(liveUrlRunId, handle).then(
        (result) => { json(res, result) },
        (error: unknown) => {
          const name = error instanceof Error ? error.name : ''
          if (name === 'UnknownRunError') { json(res, { error: 'unknown_run' }, 404); return }
          if (name === 'LiveViewUnavailableError') { json(res, { error: 'live_view_unavailable' }, 503); return }
          json(res, { error: 'live_url_mint_failed' }, 500)
        },
      )
      return
    }

    // Above the catch-all; the sha is passed raw, because a content address never needs decoding.
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
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, -'/evidence'.length))
      } catch {
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      serveRunEvidenceRead(req, res, { runId, host: deps.agentHost })
      return
    }

    // Marks history, above the `/api/runs/:id` catch-all like its read siblings.
    if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/marks$/.test(path)) {
      if (!deps.agentHost) {
        json(res, { error: 'agent_host_unavailable' }, 503)
        return
      }
      let runId: string
      try {
        runId = decodeURIComponent(path.slice('/api/runs/'.length, -'/marks'.length))
      } catch {
        json(res, { error: 'invalid_run_id' }, 400)
        return
      }
      serveRunMarksHistoryRead(req, res, { runId, host: deps.agentHost })
      return
    }

    // Above the catch-all, as `/api/runs/<id>/detail` is four segments and would read as a run id.
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
      serveRunDetailRead(req, res, { runId: detailRunId, host: deps.agentHost })
      return
    }

    // Above the catch-all, as `/api/runs/<id>/analysis` is four segments and reads as a run id.
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
      serveRunAnalysisRead(req, res, { runId: analysisRunId, host: deps.agentHost })
      return
    }

    // Above the catch-all; a pruned handoff answers 200 `evidence-incomplete`, never 404.
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
      serveRunKnowledgeRead(req, res, {
        runId: knowledgeRunId,
        host: deps.agentHost,
      })
      return
    }

    // Above the catch-all; both regexes are anchored, so neither arm can claim the other's path.
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
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      // The body is `{ run }`; members, steps and sub-actions come from `GET /api/runs/:id/detail`.
      json(res, { run })
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

    // Each run is read through `runs.knowledge`; only counts leave this arm.
    if (path === '/api/insights/knowledge-changes' && req.method === 'GET') {
      if (!deps.agentHost) {
        json(res, { status: 'unavailable', reason: 'agent_host_unavailable' }, 503)
        return
      }
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      void readInsightsKnowledgeChanges(deps.agentHost, db, { from, to }).then(
        (body) => { json(res, body) },
        () => { json(res, { status: 'unavailable', reason: 'read_failed' }, 500) },
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

    // No token: the bind guard keeps this local API local, and the answer carries no secret.
    if (path === '/api/run-readiness' && req.method === 'GET') {
      if (!deps.runServiceReadiness) {
        json(res, { error: 'This server was started without a run-service readiness predicate' }, 503)
        return
      }
      json(res, deps.runServiceReadiness())
      return
    }

    // The stream core does all framing; `url.searchParams` resolves `?handle=1&handle=2` to `1`.
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
        // Read from the same pair as the authed door; `searchParams.get` takes a repeated first.
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
          // Server-derived `metadata` is refused before any path is normalized or attribute built.
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
            // No parent kind is minted; `metadata.isSuite` and `suite_id` say it is a suite.
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
            // No parent kind is minted; see the enqueue route above.
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

    // PUT /api/suites/:suite-id — update suite file by suite-id
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

    // GET /api/suites/:suite-id — read suite file by suite-id
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
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const read = await configManager.readMasked()
          if (read.kind === 'file_invalid') {
            json(res, { error: 'file_invalid', message: read.message }, 409)
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
          json(res, {
            config,
            provider,
            revision,
            file: { path: deps.configPath ?? null, lines },
            ...(fileIssues.length > 0 ? { fileIssues } : {}),
          })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read config' }, 500)
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
          // The removed entry is held server-side for Undo; the answer never carries it.
          ;(async () => {
            try {
              const removed = await withCredentialLock(async () => {
                const credential = await readAuthEntry(providerName)
                if (credential === undefined) return undefined
                await removeAuth(providerName)
                return credential
              })
              if (removed === undefined) {
                json(res, { deleted: false })
                return
              }
              const undo = undoStore.put({ kind: 'credential', name: providerName, credential: removed }, Date.now())
              json(res, { deleted: true, undo })
            } catch (err: unknown) {
              json(res, { error: err instanceof Error ? err.message : 'Failed to delete credential' }, 500)
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
      const plugin = provider ? getLLMAuthProviderPlugin(provider) : undefined

      if (!plugin) {
        json(res, { error: `Auth plugin provider "${provider}" is not registered` }, 404)
        return
      }

      if (action === 'start' && req.method === 'POST') {
        readJsonBody<{ configName?: string; callbackUrl?: string }>(req)
          .then(async (body) => {
            if (!plugin.startAuth) {
              json(res, { error: `Provider "${provider}" does not support dashboard auth start` }, 400)
              return
            }

            try {
              const target = await requirePluginAuthConfig(configManager, body.configName, plugin)
              if (!target.ok) {
                json(res, credentialRefusalBody(target), target.status)
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

              json(res, {
                authorizeUrl: started.authorizeUrl,
                sessionId,
                mode: plugin.dashboardAuth.mode,
                created: target.created,
              })
            } catch (err: unknown) {
              json(res, { error: err instanceof Error ? err.message : 'Failed to start auth plugin flow' }, 500)
            }
          })
          .catch(() => json(res, { error: 'Invalid request body' }, 400))
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
              json(res, { error: `Provider "${provider}" does not support code exchange` }, 400)
              return
            }
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            const code = typeof body.code === 'string' ? body.code.trim() : ''
            if (!sessionId || !code) {
              json(res, { error: 'sessionId and code are required' }, 400)
              return
            }
            const session = pluginOAuthSessions.get(sessionId)
            if (!session || session.providerId !== provider) {
              json(res, { error: 'Auth session not found' }, 404)
              return
            }
            if (session.status !== 'pending') {
              json(res, { error: 'Auth session is no longer pending' }, 409)
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
                json(res, credentialRefusalBody(CREDENTIAL_PROVIDER_CONFLICT), CREDENTIAL_PROVIDER_CONFLICT.status)
                return
              }
              session.status = 'completed'
              cleanupPluginOAuthSession(session)
              pluginOAuthSessions.delete(sessionId)
              json(res, { status: 'completed', saved: true })
            } catch (err: unknown) {
              session.status = 'error'
              session.error = err instanceof Error ? err.message : 'Token exchange failed'
              cleanupPluginOAuthSession(session)
              pluginOAuthSessions.delete(sessionId)
              json(res, { error: session.error }, 500)
            }
          })
          .catch(() => json(res, { error: 'Invalid request body' }, 400))
        return
      }

      json(res, { error: 'Auth plugin route not found' }, 404)
      return
    }

    // POST /api/auth/credential — store typed credentials from dashboard
    if (path === '/api/auth/credential' && req.method === 'POST') {
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
            json(res, { error: 'configName is required' }, 400)
            return
          }
          if (!provider || !isKnownLLMProvider(provider)) {
            json(res, { error: 'valid provider is required' }, 400)
            return
          }
          if (credentialType !== 'api-key' && credentialType !== 'bearer-token') {
            json(res, { error: 'type must be api-key or bearer-token' }, 400)
            return
          }
          if (!secret) {
            json(res, { error: 'secret is required' }, 400)
            return
          }

          if (getLLMAuthProviderPlugin(provider)) {
            json(res, { error: 'Subscription providers use OAuth login' }, 400)
            return
          }

          if (credentialType === 'bearer-token' && provider !== 'anthropic-compatible') {
            json(res, { error: 'bearer-token credentials are only supported for anthropic-compatible configs' }, 400)
            return
          }

          if (credentialType === 'api-key' && !API_KEY_CREDENTIAL_PROVIDERS.has(provider)) {
            json(res, { error: 'api-key credentials are not supported for this provider' }, 400)
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
              json(res, credentialRefusalBody(target), target.status)
              return
            }
            json(res, { saved: true, created: target.created })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to save credential' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // A draft credential follows its name between unregistered names, never onto a held one.
    if (path === '/api/auth/credential/move' && req.method === 'POST') {
      readJsonBody<unknown>(req)
        .then(async (raw) => {
          const parsed = LlmCredentialMoveRequestSchema.safeParse(raw)
          if (!parsed.success) {
            json(res, { error: 'invalid_setup_input' }, 400)
            return
          }
          const from = checkCredentialName(parsed.data.from)
          const to = checkCredentialName(parsed.data.to)
          if (!from.ok || !to.ok) {
            json(res, { error: 'name_invalid' }, 400)
            return
          }
          if (!configManager) {
            json(res, { error: 'Config manager is required to move credentials' }, 400)
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
              json(res, credentialRefusalBody(refusal), refusal.status)
              return
            }
            json(res, { moved: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to move credential' }, 500)
          }
        })
        .catch(() => json(res, { error: 'invalid_setup_input' }, 400))
      return
    }

    // POST /api/llm/test — test LLM connection
    if (path === '/api/llm/test' && req.method === 'POST') {
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
            json(res, {
              success: false,
              error: 'invalid_request',
              message: 'apiKey is not accepted in LLM test requests. Save credentials for the named config instead.',
            }, 400)
            return
          }
          const providerName = typeof body.provider === 'string' ? body.provider.trim() : ''
          const modelName = typeof body.model === 'string' ? body.model.trim() : ''
          if (!providerName || !modelName) {
            json(res, { success: false, error: 'invalid_request', message: 'provider and model are required' }, 400)
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
            json(res, {
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
            json(res, {
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
            // Fixed probe text, nothing to mask.
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

            json(res, {
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

            json(res, {
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
        .catch(() => json(res, { success: false, error: 'invalid_request', message: 'Invalid request body' }, 400))
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

    // GET /api/live-editor/sessions/:id/live-url — the editor mint door.
    //
    // A copy of the run mint door above, arm for arm: 503 when unbound,
    // the op's result verbatim and its refusals mapped by error name. The DELETE arm below matches
    // one path segment after the id, so it never sees a `/live-url` suffix.
    if (req.method === 'GET' && /^\/api\/live-editor\/sessions\/[^/]+\/live-url$/.test(path)) {
      if (!deps.mintEditorLiveUrl) {
        json(res, { error: 'live_view_unavailable' }, 503)
        return
      }
      let editorSessionId: string
      try {
        editorSessionId = decodeURIComponent(
          path.slice('/api/live-editor/sessions/'.length, -'/live-url'.length),
        )
      } catch {
        json(res, { error: 'unknown_session' }, 404)
        return
      }
      void deps.mintEditorLiveUrl(editorSessionId).then(
        (result) => { json(res, result) },
        (error: unknown) => {
          const name = error instanceof Error ? error.name : ''
          if (name === 'UnknownLiveEditorSessionError') { json(res, { error: 'unknown_session' }, 404); return }
          if (name === 'LiveViewUnavailableError') { json(res, { error: 'live_view_unavailable' }, 503); return }
          json(res, { error: 'live_url_mint_failed' }, 500)
        },
      )
      return
    }

    // POST /api/live-editor/sessions/:id/auth-state — save auth state from active web Live Mode context
    const liveEditorAuthStateMatch = path.match(/^\/api\/live-editor\/sessions\/([^/]+)\/auth-state$/)
    if (liveEditorAuthStateMatch && req.method === 'POST') {
      if (!sessionManager) {
        json(res, { error: 'Live editor not available' }, 503)
        return
      }
      ;(async () => {
        let stateName = ''
        let session: { captureWebAuthState?: (name: string, options: { replace: boolean }) => Promise<unknown>; getState?: () => unknown } | undefined
        try {
          const body = await readJsonBody<{ name?: unknown; replace?: unknown }>(req)
          const parsedName = AuthStateNameSchema.safeParse(typeof body?.name === 'string' ? body.name : '')
          if (!parsedName.success) {
            json(res, { error: 'Auth state name must be a lowercase slug.' }, 400)
            return
          }

          stateName = parsedName.data
          session = sessionManager.getSession(decodeURIComponent(liveEditorAuthStateMatch[1]))
          if (!session) {
            json(res, { error: 'Session not found' }, 404)
            return
          }

          if (typeof session.captureWebAuthState !== 'function') {
            json(res, {
              error: `Could not save auth state "${stateName}" for target "${getSessionTargetNameForAuthState(session)}".`,
            }, 500)
            return
          }

          const authState = await session.captureWebAuthState(stateName, { replace: body?.replace === true })
          json(res, { authState })
        } catch (err: unknown) {
          const targetName = getSessionTargetNameForAuthState(session)
          const response = buildAuthStateSaveErrorMessage(stateName || 'unknown', targetName, err)
          json(res, { error: response.message }, response.status)
        }
      })()
      return
    }

    // POST /api/live-editor/sessions — create a new live editor session
    if (path === '/api/live-editor/sessions' && req.method === 'POST') {
      if (!sessionManager) {
        json(res, { error: 'Live editor not available' }, 503)
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
            json(res, { error: runtimeLLM.error }, 400)
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
            json(res, { error: 'Workspace path resolution not available' }, 500)
            return
          }

          try {
            const envContent = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
            envVars = parseEnvFile(envContent)
          } catch {
            json(res, { error: `workspace.envFile file could not be loaded: ${workspacePaths.envFile.workspaceRelativePath}` }, 400)
            return
          }

          try {
            const secretsContent = await readFile(workspacePaths.secretsFile.absolutePath, 'utf-8')
            secretStore = SecretStore.fromEnvContent(secretsContent)
            secretRedactor = new SecretRedactor(secretStore)
          } catch {
            json(res, { error: `workspace.secretsFile file could not be loaded: ${workspacePaths.secretsFile.workspaceRelativePath}` }, 400)
            return
          }

          const hookCatalog = await readWorkspaceHooks(configManager, deps.configPath)
          resolvedHooks = hookCatalog.resolvedHooks
          hookRegistryError = hookCatalog.hookRegistryError
          // The limits come from the project config and the entity's own `use`, not the request.
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
          json(res, { sessionId, sessionNumber }, 201)
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          // A planner limit or navigation timeout the CLI refuses is refused here, before any
          // session exists.
          const refused =
            err instanceof LivePlannerLimitsRefusedError ||
            err instanceof LiveNavigationTimeoutRefusedError
          const status = refused ? 400 : 500
          json(res, { error: message }, status)
        }
      })()
      return
    }

    // GET /api/live-editor/sessions — list all active live editor sessions
    if (path === '/api/live-editor/sessions' && req.method === 'GET') {
      if (!sessionManager) {
        json(res, { error: 'Live editor not available' }, 503)
        return
      }
      json(res, { sessions: sessionManager.listSessions() })
      return
    }

    // DELETE /api/live-editor/sessions/:id — terminate a live editor session
    const liveEditorSessionMatch = path.match(/^\/api\/live-editor\/sessions\/([^/]+)$/)
    if (liveEditorSessionMatch && req.method === 'DELETE') {
      if (!sessionManager) {
        json(res, { error: 'Live editor not available' }, 503)
        return
      }
      const sessionId = liveEditorSessionMatch[1]
      ;(async () => {
        const terminated = await sessionManager.terminateSession(sessionId)
        if (terminated) {
          json(res, { ok: true })
        } else {
          json(res, { error: 'Session not found' }, 404)
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

    // Unknown API route
    if (path.startsWith('/api/')) {
      notFound(res)
      return
    }

    // Non-API routes handled by server.ts (static files)
    notFound(res)
  }
}
