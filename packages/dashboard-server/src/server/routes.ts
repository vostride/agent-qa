import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, stat, readdir, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, isAbsolute, basename, resolve, dirname, relative } from 'node:path'

import type { AttributePredicate, DashboardDatabase, InsightsBreakdownDimension, RunArtifactRow, RunRow, StepRow } from '../db/database.js'
import type { TestRunner } from '../execution/test-runner.js'
import type { JobQueue } from '../queue/job-queue.js'
import { MemoryCatalogManager, isValidMemoryScopeId, type MemoryScope } from '../memory/memory-catalog-manager.js'
import { extractTestFileMetadata, type SupportedPlatform, type TestFileManager } from '../tests/test-file-manager.js'
import type { SuiteFileManager } from '../tests/suite-file-manager.js'
import type { ConfigManager } from '../config/index.js'
import { HookRegistryManager, isHookRegistryMutationError } from '../hooks/hook-registry-manager.js'
import { readJsonBody } from './body-parser.js'
import type { AnalyticsServiceConfig, LLMAuthProviderPlugin, ModelConfig, OAuthTokens } from '@vostride/agent-qa-core'
import { AuthStateNameSchema, buildAnalyticsEvent, buildInternalRunAttributes, captureAnalytics, mergeRunAttributes, readAuth, writeAuth, removeAuth, getAgentQaVersion, getAgentQaUpdateStatus, getProviderOptions, getLLMAuthProviderPlugin, listAuthStateMetadata, listLLMAuthProviderPlugins, ModelConfigSchema, NamedLLMConfigSchema, WorkspaceSchema, ServicesSchema, RegistrySchema, UseSchema, MobileAppStateSchema, hashStepInstruction, TimeoutConfigSchema, CacheConfigSchema, HealingConfigSchema, PlannerConfigSchema, LoggingConfigSchema, LogCaptureConfigSchema, AccessibilityConfigSchema, DashboardConfigSchema, McpConfigSchema, RecordingConfigSchema, BrowserConfigSchema, AnalyticsSchema, AgentQaConfigSchema, TestDefinitionSchema, SuiteDefinitionSchema, parseEnvFile, serializeEnvFile, parseHooksFile, runHookInSandbox, RUNTIME_IMAGE_MAP, SecretStore, SecretRedactor, redactAuthStateValue, validateUserRunAttributes, discoverWorkspaceFiles, isWorkspacePathMatch, resolveAnalyticsStandardProperties, resolveMemoryRoot, resolveWorkspaceFileTarget } from '@vostride/agent-qa-core'
import type { ResolvedWorkspacePaths, RunAttributes, WorkspaceFileKind, WorkspaceFileRecord } from '@vostride/agent-qa-core'
import { parse as parseYaml } from 'yaml'

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
const LLM_TEST_UNAUTHENTICATED_MESSAGE = 'Testing without a saved credential.'
const LLM_TEST_AUTH_ERROR_MESSAGE = 'Authentication failed. Check the saved credential for this config.'
const LLM_TEST_MODEL_NOT_FOUND_MESSAGE = 'Model not found. Check the model name.'
const LLM_TEST_NETWORK_ERROR_MESSAGE = 'Network error. Check the exact base URL and try again.'
const DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS = 60_000
const REMOTE_LLM_CONNECTION_TEST_TIMEOUT_MS = 10_000
const LOCAL_COMPATIBLE_LLM_CONNECTION_TEST_TIMEOUT_MS = 120_000
const LOCAL_COMPATIBLE_LLM_PROVIDERS = new Set(['openai-compatible', 'anthropic-compatible'])
const PLUGIN_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
const DASHBOARD_PRODUCT_EVENT_NAMES = [
  'agent-qa.dashboard.opened',
  'agent-qa.dashboard.live_mode.started',
  'agent-qa.dashboard.entity.created',
] as const
type DashboardProductEventName = typeof DASHBOARD_PRODUCT_EVENT_NAMES[number]
const DASHBOARD_PRODUCT_EVENT_NAME_SET = new Set<DashboardProductEventName>(DASHBOARD_PRODUCT_EVENT_NAMES)
const DASHBOARD_PRODUCT_EVENT_PROPERTY_KEYS = {
  'agent-qa.dashboard.opened': [],
  'agent-qa.dashboard.live_mode.started': ['platform', 'entity_type'],
  'agent-qa.dashboard.entity.created': ['entity_type', 'outcome'],
} as const satisfies Record<DashboardProductEventName, readonly string[]>

type DashboardExecutionTimeoutSource =
  | 'test.use.timeout.test'
  | 'suite.use.timeout.test'
  | 'config.use.timeout.test'
  | 'none'

type ConfigSectionValidationResult =
  | { success: true }
  | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } }

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

async function requirePluginAuthConfig(
  configManager: ConfigManager | undefined,
  configName: unknown,
  plugin: LLMAuthProviderPlugin,
): Promise<{ ok: true; configName: string } | { ok: false; error: string }> {
  const targetConfigName = typeof configName === 'string' ? configName.trim() : ''
  if (!targetConfigName) {
    return { ok: false, error: 'configName is required' }
  }
  if (!configManager) {
    return { ok: false, error: 'Config manager is required to save OAuth credentials' }
  }

  const config = await configManager.read() as { registry?: { llms?: unknown[] } }
  const llms = Array.isArray(config.registry?.llms) ? config.registry.llms : []
  const match = llms.find((item) => {
    return Boolean(item)
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as { name?: unknown }).name === targetConfigName
  }) as { provider?: unknown } | undefined

  if (!match) {
    return { ok: false, error: `LLM config "${targetConfigName}" not found` }
  }
  if (match.provider !== plugin.providerId) {
    return { ok: false, error: `LLM config "${targetConfigName}" uses ${String(match.provider)}, not ${plugin.providerId}` }
  }

  return { ok: true, configName: targetConfigName }
}

async function requireCredentialConfig(
  configManager: ConfigManager | undefined,
  configName: unknown,
  provider: string,
): Promise<{ ok: true; configName: string } | { ok: false; error: string }> {
  const targetConfigName = typeof configName === 'string' ? configName.trim() : ''
  if (!targetConfigName) {
    return { ok: false, error: 'configName is required' }
  }
  if (!API_KEY_CREDENTIAL_PROVIDERS.has(provider)) {
    return { ok: false, error: 'provider must support typed credentials' }
  }
  if (!configManager) {
    return { ok: false, error: 'Config manager is required to save credentials' }
  }

  const config = await configManager.read() as { registry?: { llms?: unknown[] } }
  const llms = Array.isArray(config.registry?.llms) ? config.registry.llms : []
  const match = llms.find((item) => {
    return Boolean(item)
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as { name?: unknown }).name === targetConfigName
  }) as { provider?: unknown } | undefined

  if (!match) {
    return { ok: false, error: `LLM config "${targetConfigName}" not found` }
  }
  if (match.provider !== provider) {
    return { ok: false, error: `LLM config "${targetConfigName}" uses ${String(match.provider)}, not ${provider}` }
  }

  return { ok: true, configName: targetConfigName }
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

function builtinLLMProviderMetadata(): DashboardLLMProviderMetadata[] {
  return [
    {
      id: 'openai-compatible',
      label: 'OpenAI-compatible',
      auth: { kind: 'api-key', credentialTypes: ['api-key'], optional: true },
      modelAdapter: 'openai-responses',
    },
    {
      id: 'anthropic-compatible',
      label: 'Anthropic-compatible',
      auth: { kind: 'api-key', credentialTypes: ['api-key', 'bearer-token'], optional: true },
      modelAdapter: 'anthropic-messages',
    },
    {
      id: 'gemini',
      label: 'Gemini',
      auth: { kind: 'api-key', credentialTypes: ['api-key'] },
    },
  ]
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

type DashboardRuntimeLLMConfig = Pick<
  ModelConfig,
  'provider' | 'model' | 'apiKey' | 'authToken' | 'baseURL' | 'providerHeaders'
> & {
  screenshotSize?: number
  effectiveResolution?: number
  modelAdapter?: 'openai-responses' | 'anthropic-messages'
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
  if (typeof raw.screenshotSize === 'number') config.screenshotSize = raw.screenshotSize
  if (typeof raw.effectiveResolution === 'number') config.effectiveResolution = raw.effectiveResolution

  return { configName: raw.name, config }
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

  const rawConfig = await configManager.read()
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

  const runtimeConfig: DashboardRuntimeLLMConfig = { ...normalized.config }
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

function extractProviderErrorMessage(err: unknown): { message: string; statusCode?: number } {
  const errObj = err as Record<string, unknown>
  const statusCode = errObj?.statusCode as number | undefined
  const responseBody = errObj?.responseBody as string | undefined
  const data = errObj?.data as Record<string, unknown> | undefined
  const apiError = data?.error as Record<string, string> | undefined

  let message = err instanceof Error ? err.message : String(err)

  if (apiError?.message && apiError.message !== 'Error') {
    message = apiError.message
  } else if (data?.detail && typeof data.detail === 'string') {
    message = data.detail
  } else if (responseBody) {
    try {
      const body = JSON.parse(responseBody)
      if (body?.detail) message = body.detail
      else if (body?.error?.message && body.error.message !== 'Error') message = body.error.message
    } catch {
      // response body was not JSON
    }
  }

  return { message, statusCode }
}

function classifyProviderError(message: string, statusCode?: number): string {
  const fullContext = `${message} ${statusCode ?? ''}`
  if (/auth|unauthorized|401|invalid.*key|permission/i.test(fullContext)) {
    return 'auth_error'
  }
  if (/model.*not.*support|model.*not.*found|not found|404|does not exist/i.test(fullContext)) {
    return 'model_not_found'
  }
  if (/ECONNREFUSED|ENOTFOUND|timeout|abort|fetch failed|network/i.test(fullContext)) {
    return 'network_error'
  }
  if (/rate|429|quota|limit/i.test(fullContext)) {
    return 'rate_limit'
  }
  if (/invalid_request|400|bad request/i.test(fullContext)) {
    return 'invalid_request'
  }
  return 'provider_error'
}

function publicLLMTestMessage(category: string, providerMessage: string): string {
  switch (category) {
    case 'auth_error':
      return LLM_TEST_AUTH_ERROR_MESSAGE
    case 'model_not_found':
      return LLM_TEST_MODEL_NOT_FOUND_MESSAGE
    case 'network_error':
      return LLM_TEST_NETWORK_ERROR_MESSAGE
    case 'provider_error':
      return `Connection failed. ${providerMessage}`
    default:
      return providerMessage
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

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost')
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

function isDashboardProductEventName(value: unknown): value is DashboardProductEventName {
  return typeof value === 'string' && DASHBOARD_PRODUCT_EVENT_NAME_SET.has(value as DashboardProductEventName)
}

function filterDashboardProductEventProperties(
  name: DashboardProductEventName,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const allowedKeys = DASHBOARD_PRODUCT_EVENT_PROPERTY_KEYS[name]
  const filtered: Record<string, unknown> = {}
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      filtered[key] = properties[key]
    }
  }
  return filtered
}

async function readAnalyticsServiceConfig(configManager: ConfigManager | undefined): Promise<AnalyticsServiceConfig> {
  if (!configManager) return {}

  try {
    const config = await configManager.read() as { analytics?: { privacy?: unknown } } | undefined
    if (config?.analytics?.privacy === true) {
      return { analytics: { privacy: true } }
    }
  } catch {
    // Fail closed for telemetry while keeping the HTTP route non-blocking.
    return { analytics: { privacy: true } }
  }
  return {}
}

function getPathInsideDir(candidatePath: string, rootDir: string): string | null {
  const relativePath = relative(rootDir, candidatePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null
  }
  return relativePath
}

function isPlainFileName(value: string): boolean {
  const fileName = value.trim()
  return fileName.length > 0
    && fileName !== '.'
    && fileName !== '..'
    && !isAbsolute(fileName)
    && fileName === basename(fileName)
    && !/[\\/\0]/.test(fileName)
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
  runner?: 'local' | 'browserstack'
  userAttributes?: unknown
}): RunAttributes {
  const internal = buildInternalRunAttributes({
    trigger: input.trigger,
    runner: input.runner ?? 'local',
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

function validateAnalyticsPassRateScope(value: unknown): ConfigSectionValidationResult {
  const result = AnalyticsSchema.shape.passRateScope.safeParse(value)
  if (result.success) return { success: true }
  return {
    success: false,
    error: {
      issues: result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
      })),
    },
  }
}

async function readAnalyticsScopePredicates(configManager: ConfigManager | undefined): Promise<{ ok: true; predicates: AttributePredicate[] } | { ok: false; error: string }> {
  if (!configManager) return { ok: true, predicates: [] }
  const config = await configManager.read()
  const parsedConfig = AgentQaConfigSchema.safeParse(config)
  if (!parsedConfig.success) {
    return { ok: true, predicates: [] }
  }
  return parseAnalyticsScopePredicates(parsedConfig.data as Record<string, unknown>)
}

function calculateFlakyMetrics(runs: RunRow[]): { score: number; statusCount: number } {
  const statuses = runs
    .filter(r => r.status === 'passed' || r.status === 'failed')
    .map(r => r.status)
  let alternations = 0
  for (let i = 1; i < statuses.length; i++) {
    if (statuses[i] !== statuses[i - 1]) alternations++
  }
  return {
    score: statuses.length > 1 ? alternations / (statuses.length - 1) : 0,
    statusCount: statuses.length,
  }
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
    const config = await configManager.read()
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
    const config = await configManager.read()
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
    const config = await configManager.read()
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
  if (!('memory' in payload)) missing.push('memory')
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
  const sanitized = redactAuthStateValue(sanitizeSecretTemplates(payload))
  if (!isRecord(sanitized)) return payload
  const config = sanitized.config
  if (!isRecord(config) || !('secretsFile' in config)) return sanitized as unknown as RunArtifactRow['payload']
  return {
    ...sanitized,
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

function sanitizeAuthStateForResponse<T>(value: T): T {
  return redactAuthStateValue(value)
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

function sanitizeQueuedRunMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const { args: _args, target: _target, isSuite: _isSuite, ...safeMetadata } = metadata ?? {}
  return safeMetadata
}

function resolveArtifactPath(
  candidatePath: string,
  rootDir: string,
  apiPrefix: '/api/screenshots/' | '/api/videos/',
): string | null {
  const normalizedCandidate = candidatePath.trim()
  if (!normalizedCandidate) return null
  const resolvedRootDir = resolve(rootDir)

  if (isAbsolute(normalizedCandidate)) {
    const resolvedAbsolute = resolve(normalizedCandidate)
    return getPathInsideDir(resolvedAbsolute, resolvedRootDir) ? resolvedAbsolute : null
  }

  const relativePath = normalizedCandidate.startsWith(apiPrefix)
    ? normalizedCandidate.slice(apiPrefix.length)
    : normalizedCandidate
  const resolvedPath = resolve(resolvedRootDir, relativePath)
  return getPathInsideDir(resolvedPath, resolvedRootDir) ? resolvedPath : null
}

async function cleanupDeletedRunArtifacts(
  deletedRunIds: string[],
  screenshotPaths: string[],
  videoPaths: string[],
  dirs: {
    screenshotsDir?: string
    videosDir?: string
  },
): Promise<void> {
  const cleanupTargets = new Set<string>()

  for (const runId of deletedRunIds) {
    if (dirs.screenshotsDir) cleanupTargets.add(join(dirs.screenshotsDir, runId))
    if (dirs.videosDir) cleanupTargets.add(join(dirs.videosDir, runId))
  }

  if (dirs.screenshotsDir) {
    for (const screenshotPath of screenshotPaths) {
      const resolvedPath = resolveArtifactPath(screenshotPath, dirs.screenshotsDir, '/api/screenshots/')
      if (resolvedPath) cleanupTargets.add(resolvedPath)
    }
  }

  if (dirs.videosDir) {
    for (const videoPath of videoPaths) {
      const resolvedPath = resolveArtifactPath(videoPath, dirs.videosDir, '/api/videos/')
      if (resolvedPath) cleanupTargets.add(resolvedPath)
    }
  }

  await Promise.allSettled(
    [...cleanupTargets].map((targetPath) => rm(targetPath, { recursive: true, force: true })),
  )
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
  artifactsDir?: string
  workspacePaths?: ResolvedWorkspacePaths
  testRunner?: TestRunner
  jobQueue?: JobQueue
  testFileManager?: TestFileManager
  suiteFileManager?: SuiteFileManager
  configManager?: ConfigManager
  configPath?: string

  llmConfig?: DashboardRuntimeLLMConfig
  authFetch?: typeof globalThis.fetch
  sessionManager?: import('../live-editor/session-manager.js').SessionManager
  analyticsBridge?: {
    buildAnalyticsEvent: typeof buildAnalyticsEvent
    captureAnalytics: typeof captureAnalytics
    resolveAnalyticsStandardProperties: typeof resolveAnalyticsStandardProperties
  }
}

export function createRouter(deps: RouterDeps): (req: IncomingMessage, res: ServerResponse) => void
export function createRouter(db: DashboardDatabase, artifactsDir?: string): (req: IncomingMessage, res: ServerResponse) => void
export function createRouter(dbOrDeps: DashboardDatabase | RouterDeps, artifactsDir?: string): (req: IncomingMessage, res: ServerResponse) => void {
  const deps: RouterDeps = 'db' in dbOrDeps && typeof (dbOrDeps as RouterDeps).db === 'object' && 'getRuns' in ((dbOrDeps as RouterDeps).db ?? {})
    ? dbOrDeps as RouterDeps
    : { db: dbOrDeps as DashboardDatabase, artifactsDir }
  const { db, testRunner, jobQueue, testFileManager, suiteFileManager, configManager, workspacePaths, llmConfig, authFetch, sessionManager } = deps
  const pluginOAuthSessions = new Map<string, PluginOAuthSession>()
  const analyticsBridge = deps.analyticsBridge ?? {
    buildAnalyticsEvent,
    captureAnalytics,
    resolveAnalyticsStandardProperties,
  }
  const ssDir = deps.artifactsDir ? join(deps.artifactsDir, 'screenshots') : undefined
  const vidDir = deps.artifactsDir ? join(deps.artifactsDir, 'videos') : undefined
  const memoryCatalogManager = new MemoryCatalogManager({ configManager, configPath: deps.configPath })

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      cors(res)
      return
    }

    const url = parseUrl(req)
    const path = url.pathname

    // GET /api/auth-states — list safe auth-state metadata only
    if (path === '/api/auth-states' && req.method === 'GET') {
      if (!configManager || !deps.configPath) {
        json(res, { error: 'Auth-state metadata not available' }, 503)
        return
      }
      ;(async () => {
        try {
          const config = await configManager.read()
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

    // POST /api/analytics/events — best-effort dashboard product analytics bridge
    if (path === '/api/analytics/events' && req.method === 'POST') {
      readJsonBody<{ name?: unknown; properties?: unknown }>(req)
        .then((body) => {
          if (
            !isPlainRecord(body)
            || !isDashboardProductEventName(body.name)
            || (
              Object.prototype.hasOwnProperty.call(body, 'properties')
              && body.properties !== undefined
              && !isPlainRecord(body.properties)
            )
          ) {
            json(res, { error: 'Invalid analytics event' }, 400)
            return
          }

          const name = body.name
          const browserProperties = isPlainRecord(body.properties) ? body.properties : {}
          json(res, { accepted: true }, 202)

          void (async () => {
            try {
              const config = await readAnalyticsServiceConfig(configManager)
              if (config.analytics?.privacy === true) {
                return
              }

              const standardProperties = await analyticsBridge.resolveAnalyticsStandardProperties({ surface: 'dashboard-ui' })
              const event = analyticsBridge.buildAnalyticsEvent({
                name,
                properties: {
                  ...filterDashboardProductEventProperties(name, browserProperties),
                  ...standardProperties,
                },
              })
              await analyticsBridge.captureAnalytics(event, { config })
            } catch {
              // Analytics is intentionally best-effort and invisible to dashboard users.
            }
          })()
        })
        .catch(() => json(res, { error: 'Invalid analytics event' }, 400))
      return
    }

    // GET /api/runs
    if (path === '/api/runs' && req.method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined
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
            status,
            name,
            from,
            to,
            attributePredicates: attributePredicatesResult.predicates,
          })
          const enrichedRuns = allRuns.map(run => {
            if (run.suiteId && !run.parentRunId) {
              const tests = db.getRunsByParent(run.id).map(test => enrichRunRow(test, targetPlatforms))
              return enrichRunRow(run, targetPlatforms, tests)
            }
            return enrichRunRow(run, targetPlatforms)
          })
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
          json(res, { runs, total: filtered.length, targets: targetOptions })
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
      json(res, sanitizeAuthStateForResponse({
        run,
        artifact: sanitizeArtifactForResponse(bundle.artifact),
        children: bundle.children.map((child) => ({
          ...child,
          artifact: sanitizeArtifactForResponse(child.artifact),
        })),
        missingSections: getArtifactMissingSections(bundle.artifact),
      }))
      return
    }

    // GET /api/runs/:id/accessibility
    if (path.startsWith('/api/runs/') && path.endsWith('/accessibility') && req.method === 'GET') {
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const summary = db.getAccessibilitySummary(id)
      json(res, summary)
      return
    }

    // GET /api/runs/:id/steps/:n/reasoning — structured reasoning trace for a step
    const reasoningMatch = path.match(/^\/api\/runs\/([^/]+)\/steps\/(\d+)\/reasoning$/)
    if (reasoningMatch && req.method === 'GET') {
      const [, runId, stepOrderStr] = reasoningMatch
      const run = db.getRun(runId)
      if (!run) { notFound(res, 'Run not found'); return }
      const stepOrder = parseInt(stepOrderStr, 10)
      const trace = db.getReasoningTrace(runId, stepOrder)
      if (trace) {
        json(res, sanitizeAuthStateForResponse({ trace }))
        return
      }
      // Fallback: construct legacy trace from step data for backward compatibility
      const steps = db.getSteps(runId)
      const step = steps.find(s => s.stepOrder === stepOrder)
      if (!step) { notFound(res, 'Step not found'); return }
      json(res, sanitizeAuthStateForResponse({
        trace: {
          id: null,
          stepId: step.id,
          observeText: step.observation,
          observeDuration: null,
          planReasoning: step.reasoning,
          planConfidence: step.confidence,
          planAction: step.plannedAction,
          planDuration: null,
          executeAction: step.action,
          executeDuration: null,
          verifyReasoning: null,
          verifySuccess: step.result === 'success' ? true : step.result === 'failure' ? false : null,
          verifyDuration: null,
          healAttempts: step.healingAttempts,
          totalDuration: step.duration,
          screenStateBefore: null,
          screenStateAfter: null,
          createdAt: step.createdAt,
        },
      }))
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

      if (run.suiteId && !run.parentRunId) {
        const childRuns = db.getRunsByParent(id)
        const allRunIds = [id, ...childRuns.map((c: any) => c.id)]
        let allLogs: any[] = []
        for (const rid of allRunIds) {
          allLogs.push(...db.getExecutionLogs({ runId: rid, stepId, type }))
        }
        json(res, sanitizeAuthStateForResponse({ logs: allLogs }))
        return
      }

      const logs = db.getExecutionLogs({ runId: id, stepId, type })
      json(res, sanitizeAuthStateForResponse({ logs }))
      return
    }

    // GET /api/runs/:id/logs
    if (path.startsWith('/api/runs/') && path.endsWith('/logs') && req.method === 'GET') {
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const stepId = url.searchParams.get('stepId') ?? undefined
      const level = url.searchParams.get('level') ?? undefined
      const source = url.searchParams.get('source') ?? undefined
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 500
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0
      const logs = db.getLogs({ runId: id, stepId, level, source, limit, offset })
      json(res, sanitizeAuthStateForResponse({ logs, total: logs.length }))
      return
    }

    // GET /api/runs/:id/steps
    if (path.startsWith('/api/runs/') && path.endsWith('/steps') && req.method === 'GET') {
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const steps = db.getSteps(id)
      json(res, sanitizeAuthStateForResponse({ steps }))
      return
    }

    // POST /api/runs/:id/cancel — cancel a pending or running execution
    if (path.startsWith('/api/runs/') && path.endsWith('/cancel') && req.method === 'POST') {
      if (!jobQueue) {
        json(res, { error: 'Queue not available' }, 503)
        return
      }
      const runId = path.slice('/api/runs/'.length, path.length - '/cancel'.length)
      const cancelled = jobQueue.cancel(runId)
      if (cancelled) {
        // For pending jobs, JobQueue already set status='cancelled'.
        // For running jobs, JobQueue emits 'cancel-running' which triggers executionManager.kill().
        // Update DB with cancel metadata for running jobs.
        try {
          const run = db.getRun(runId)
          if (run && run.status === 'cancelled') {
            const duration = run.startedAt
              ? Date.now() - new Date(run.startedAt).getTime()
              : 0
            db.updateRun(runId, {
              duration,
              endedAt: new Date().toISOString(),
              failureSummary: 'Test cancelled by user',
            })
          }
        } catch { /* best-effort */ }
        json(res, { cancelled: true })
      } else {
        json(res, { error: 'Run not found or not cancellable' }, 404)
      }
      return
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

        void cleanupDeletedRunArtifacts(
          deletedRun.deletedRunIds,
          deletedRun.screenshotPaths,
          deletedRun.videoPaths,
          {
            screenshotsDir: ssDir,
            videosDir: vidDir,
          },
        ).finally(() => {
          json(res, { deleted: true, deletedRunIds: deletedRun.deletedRunIds })
        })
      } catch {
        json(res, { error: 'Failed to delete run' }, 500)
      }
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
      const steps = db.getSteps(id)
      const attempts = db.getRunsByParent(id)
      if (run.suiteId && !run.parentRunId) {
        const tests = db.getRunsByParent(id)
        json(res, sanitizeAuthStateForResponse({ run, steps, attempts, tests }))
      } else {
        json(res, sanitizeAuthStateForResponse({ run, steps, attempts }))
      }
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

    // GET /api/screenshots/:runId/:filename
    if (path.startsWith('/api/screenshots/') && req.method === 'GET') {
      const segments = path.split('/')
      if (segments.length !== 5 || !ssDir) {
        notFound(res)
        return
      }
      const runId = segments[3]
      const filename = segments[4]

      if (runId.includes('..') || filename.includes('..') || runId.includes('/') || filename.includes('/')) {
        notFound(res, 'Invalid path')
        return
      }

      const filePath = join(ssDir, runId, filename)
      const resolvedPath = resolve(filePath)
      if (!resolvedPath.startsWith(resolve(ssDir))) {
        notFound(res, 'Invalid path')
        return
      }

      stat(filePath).then(s => {
        if (!s.isFile()) {
          notFound(res, 'Screenshot not found')
          return
        }
        readFile(filePath).then(buffer => {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': buffer.length,
            'Access-Control-Allow-Origin': '*',
          })
          res.end(buffer)
        }).catch(() => notFound(res, 'Screenshot not found'))
      }).catch(() => notFound(res, 'Screenshot not found'))
      return
    }

    // GET /api/videos/:runId/:filename
    if (path.startsWith('/api/videos/') && req.method === 'GET') {
      const segments = path.split('/')
      if (segments.length !== 5 || !vidDir) {
        notFound(res)
        return
      }
      const runId = segments[3]
      const filename = segments[4]

      if (runId.includes('..') || filename.includes('..') || runId.includes('/') || filename.includes('/')) {
        notFound(res, 'Invalid path')
        return
      }

      const videoPath = join(vidDir, runId, filename)
      const resolvedVideo = resolve(videoPath)
      const resolvedVidDir = resolve(vidDir)
      if (!getPathInsideDir(resolvedVideo, resolvedVidDir)) {
        notFound(res, 'Invalid path')
        return
      }

      const tryServe = (filePath: string) => stat(filePath).then(s => {
        if (!s.isFile()) {
          notFound(res, 'Video not found')
          return
        }

        const contentType = filePath.endsWith('.mp4') ? 'video/mp4' : 'video/webm'
        const range = req.headers.range
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-')
          const start = parseInt(parts[0], 10)
          const end = parts[1] ? parseInt(parts[1], 10) : s.size - 1
          const chunkSize = end - start + 1

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${s.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
          })
          createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': s.size,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          })
          createReadStream(filePath).pipe(res)
        }
      })
      tryServe(videoPath).catch(() => notFound(res, 'Video not found'))
      return
    }

    // GET /api/execution/active — list currently running tests
    if (path === '/api/execution/active' && req.method === 'GET') {
      const active = testRunner ? testRunner.getActiveExecutions() : []
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
              runner: 'local',
              userAttributes: body.attributes,
            })
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
            return
          }
          const runId = jobQueue.enqueue({
            name: body.name,
            filePath: normalizedFileTarget?.storagePath,
            kind: isSuiteFile ? 'suite-parent' : 'test',
            attributes,
            priority: body.priority,
            platform: body.platform,
            parallel: body.parallel,
            metadata: {
              ...sanitizeQueuedRunMetadata(body.metadata),
              args: normalizedFileTarget ? [normalizedFileTarget.executionPath] : [],
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
      readJsonBody<{ file?: string; patterns?: string[]; tags?: unknown; noCache?: boolean; noMemory?: boolean; local?: boolean; triggerSource?: unknown }>(req)
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
            args.push('--no-cache')
          }
          if (body.noMemory) {
            args.push('--no-memory')
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
            kind: isSuite ? 'suite-parent' : 'test',
            attributes: buildRunRequestAttributes({
              trigger: triggerSource.trigger,
              runner: body.local === false ? 'browserstack' : 'local',
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

    // GET /api/execution/events — SSE stream for live execution events
    if (path === '/api/execution/events' && req.method === 'GET') {
      if (!testRunner) {
        json(res, { error: 'Execution not available' }, 503)
        return
      }

      const runId = url.searchParams.get('runId') ?? undefined
      const lastEventId = req.headers['last-event-id'] as string | undefined

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(':ok\n\n')

      // Replay buffered events for reconnection
      if (lastEventId && runId) {
        const lastId = parseInt(lastEventId, 10)
        const buffered = testRunner.getBufferedEvents(runId)
        for (const evt of buffered) {
          if (evt.id > lastId) {
            res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`)
          }
        }
      } else if (runId) {
        // New connection — replay all buffered events
        const buffered = testRunner.getBufferedEvents(runId)
        for (const evt of buffered) {
          res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`)
        }
      }

      const onEvent = (evtRunId: string, event: { id: number; type: string; [key: string]: unknown }) => {
        if (runId && evtRunId !== runId) return
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      }

      testRunner.on('execution-event', onEvent)

      const heartbeat = setInterval(() => {
        res.write(':\n\n')
      }, 15_000)

      req.on('close', () => {
        clearInterval(heartbeat)
        testRunner.removeListener('execution-event', onEvent)
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
          const found = await testFileManager.findByTestId(tId)
          if (!found) {
            notFound(res, 'Test not found')
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

    // GET /api/analytics/tests/:name
    if (path.startsWith('/api/analytics/tests/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/analytics/tests/'.length))
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0
      const from = url.searchParams.get('from') ?? undefined
      void readAnalyticsScopePredicates(configManager)
        .then((scopeResult) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }

          const runs = db.getRunsByTestName(name, { limit, offset })
          const total = db.getRunsByTestNameCount(name)
          const trends = db.getTestTrends(name, { from })
          const allRunsForFlakiness = db.getRunsByTestName(name, { limit: 100 })
          const flakyMetrics = calculateFlakyMetrics(allRunsForFlakiness)
          const flakyScore = flakyMetrics.score
          const configured = scopeResult.predicates.length > 0
          const scopedRuns = configured
            ? db.getRunsByTestName(name, { limit, offset, attributePredicates: scopeResult.predicates })
            : runs
          const scopedTotal = configured
            ? db.getRunsByTestNameCount(name, { attributePredicates: scopeResult.predicates })
            : total
          const scopedTrends = configured
            ? db.getTestTrends(name, { from, attributePredicates: scopeResult.predicates })
            : trends
          const scopedRunsForFlakiness = configured
            ? db.getRunsByTestName(name, { limit: 100, attributePredicates: scopeResult.predicates })
            : allRunsForFlakiness
          const scopedFlakyScore = calculateFlakyMetrics(scopedRunsForFlakiness).score

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
          const flakyMetrics = calculateFlakyMetrics(allRunsForFlakiness)
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
          const scopedFlakyScore = calculateFlakyMetrics(scopedRunsForFlakiness).score

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
          const config = await configManager.read()
          const configObj = config as Record<string, unknown>
          const registry = configObj.registry as Record<string, unknown> | undefined
          const targets = registry?.targets as Record<string, unknown> | undefined
          const names = targets ? Object.keys(targets) : []
          json(res, { targets: names })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read targets' }, 500)
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
          const config = await configManager.readMasked()
          const configObj = config as Record<string, unknown>
          const registry = configObj.registry as Record<string, unknown> | undefined
          const llms = (registry?.llms ?? configObj.llms) as Array<Record<string, unknown>> | undefined
          const use = configObj.use as Record<string, unknown> | undefined
          const activeLlm = (use?.llm ?? configObj.defaultLLM) as string | undefined
          const defaultCfg = llms?.find((c) => c.name === activeLlm)
          const provider = (defaultCfg?.provider as string) ?? null
          json(res, { config, provider })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read config' }, 500)
        }
      })()
      return
    }

    // PUT /api/config/llms — update registry.llms array + use.llm
    if (path === '/api/config/llms' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<{ llms: unknown[]; defaultLLM?: string; activeLlm?: string }>(req)
        .then(async (body) => {
          try {
            if (!Array.isArray(body.llms) || body.llms.length === 0) {
              json(res, { error: 'llms array is required and must not be empty' }, 400)
              return
            }
            const selectedLlm = body.activeLlm ?? body.defaultLLM
            const errors: string[] = []
            const names: string[] = []
            const sanitizedArray: Array<ReturnType<typeof NamedLLMConfigSchema.parse>> = []
            for (const item of body.llms) {
              const result = NamedLLMConfigSchema.safeParse(item)
              if (!result.success) {
                for (const issue of result.error.issues) {
                  errors.push(`${issue.path.join('.')}: ${issue.message}`)
                }
              } else {
                names.push(result.data.name)
                sanitizedArray.push(result.data)
              }
            }
            const dupes = names.filter((n, i) => names.indexOf(n) !== i)
            if (dupes.length > 0) {
              errors.push(`Duplicate config names: ${[...new Set(dupes)].join(', ')}`)
            }
            if (!selectedLlm || !names.includes(selectedLlm)) {
              errors.push(`use.llm "${selectedLlm}" does not match any name in registry.llms`)
            }
            if (errors.length > 0) {
              json(res, { error: 'Validation failed', details: errors }, 400)
              return
            }
            await configManager.replaceSectionRaw('registry.llms', sanitizedArray)
            await configManager.replaceSectionRaw('use.llm', selectedLlm)
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update LLM config' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // PUT /api/config/default-llm — switch active LLM (use.llm)
    if (path === '/api/config/default-llm' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<{ defaultLLM?: string; llm?: string }>(req)
        .then(async (body) => {
          try {
            const llmName = body.llm ?? body.defaultLLM
            if (!llmName || typeof llmName !== 'string') {
              json(res, { error: 'use.llm string is required' }, 400)
              return
            }
            const config = await configManager.readMasked()
            const configObj = config as Record<string, unknown>
            const registry = configObj.registry as Record<string, unknown> | undefined
            const llms = (registry?.llms ?? configObj.llms) as Array<Record<string, unknown>> | undefined
            const names = (llms ?? []).map((c) => c.name as string)
            if (!names.includes(llmName)) {
              json(res, { error: `use.llm "${llmName}" does not match any name in registry.llms` }, 400)
              return
            }
            await configManager.replaceSectionRaw('use.llm', llmName)
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update use.llm' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // POST /api/config/farm/test-connection — test farm provider credentials
    if (path === '/api/config/farm/test-connection' && req.method === 'POST') {
      readJsonBody<{ provider: string; username: string; accessKey: string }>(req)
        .then(async (body) => {
          if (body.provider !== 'browserstack') {
            json(res, { error: 'Only BrowserStack is currently supported' }, 400)
            return
          }
          try {
            const auth = Buffer.from(`${body.username}:${body.accessKey}`).toString('base64')
            const response = await fetch('https://api-cloud.browserstack.com/app-automate/devices.json', {
              headers: { Authorization: `Basic ${auth}` },
            })
            if (response.ok) {
              json(res, { success: true })
            } else if (response.status === 401) {
              json(res, { success: false, error: 'Invalid credentials' })
            } else {
              json(res, { success: false, error: `BrowserStack API returned ${response.status}` })
            }
          } catch (err) {
            json(res, { success: false, error: err instanceof Error ? err.message : 'Connection failed' })
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // PUT /api/config/settings — update config sections
    if (path === '/api/config/settings' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<Record<string, unknown>>(req)
        .then(async (body) => {
          try {
            const sectionValidators: Record<string, { safeParse: (v: unknown) => ConfigSectionValidationResult }> = {
              'use.timeout': TimeoutConfigSchema,
              'use.healing': HealingConfigSchema,
              'use.planner': PlannerConfigSchema,
              'use.logCapture': LogCaptureConfigSchema,
              'use.browser': BrowserConfigSchema,
              'use.browser.headless': BrowserConfigSchema.shape.headless,
              'services.memory': ServicesSchema.shape.memory,
              'services.cache': CacheConfigSchema,
              'services.logging': LoggingConfigSchema,
              'services.recording': RecordingConfigSchema,
              'services.accessibility': AccessibilityConfigSchema,
              'services.dashboard': DashboardConfigSchema,
              'services.mcp': McpConfigSchema,
              'registry.targets': RegistrySchema.shape.targets,
              'registry.devices': RegistrySchema.shape.devices,
              'registry.providers': RegistrySchema.shape.providers,
              'analytics.passRateScope': { safeParse: validateAnalyticsPassRateScope },
              'workspace.testMatch': WorkspaceSchema.shape.testMatch,
              'workspace.suiteMatch': WorkspaceSchema.shape.suiteMatch,
              'workspace.hooksFile': WorkspaceSchema.shape.hooksFile,
              'workspace.agentRules': WorkspaceSchema.shape.agentRules,
              'workspace.envFile': WorkspaceSchema.shape.envFile,
              'workspace.secretsFile': WorkspaceSchema.shape.secretsFile,
              'use.mobile': UseSchema.shape.mobile,
              'use.mobile.appState': MobileAppStateSchema,
              'use.parallel': UseSchema.shape.parallel,
            }
            const objectSections = [
              'use.timeout',
              'use.healing',
              'use.planner',
              'use.logCapture',
              'use.browser',
              'use.mobile',
              'services.memory',
              'services.cache',
              'services.logging',
              'services.recording',
              'services.accessibility',
              'services.dashboard',
              'services.mcp',
              'registry.targets',
              'registry.devices',
              'registry.providers',
              'analytics.passRateScope',
            ] as const
            const arraySections = ['workspace.testMatch', 'workspace.testPathIgnore', 'workspace.suiteMatch', 'registry.llms'] as const
            const scalarSections = [
              'workspace.agentRules',
              'workspace.hooksFile',
              'workspace.envFile',
              'workspace.secretsFile',
              'use.llm',
              'use.mobile.appState',
              'use.browser.headless',
              'use.parallel',
            ] as const

            const currentConfig = await configManager.read()
            const currentUse = isRecord(currentConfig.use) ? currentConfig.use : {}
            const currentBrowser = isRecord(currentUse.browser) ? currentUse.browser : {}
            const currentHasRootHeadless = typeof currentUse.headless === 'boolean'
            const currentHasBrowserHeadless = typeof currentBrowser.headless === 'boolean'
            const requestHasRootHeadless = Object.prototype.hasOwnProperty.call(body, 'use.headless')
            const requestHasBrowserHeadlessScalar = Object.prototype.hasOwnProperty.call(body, 'use.browser.headless')
            const requestBrowserBlock = body['use.browser']
            const requestHasBrowserHeadlessObject = isRecord(requestBrowserBlock) && typeof requestBrowserBlock.headless === 'boolean'
            if (
              currentHasRootHeadless
              && !currentHasBrowserHeadless
              && !requestHasBrowserHeadlessScalar
              && !requestHasBrowserHeadlessObject
            ) {
              body['use.browser.headless'] = currentUse.headless
            }

            const allowedSettingsPaths = new Set<string>([
              ...Object.keys(sectionValidators),
              ...objectSections,
              ...arraySections,
              ...scalarSections,
              'use.headless',
            ])
            const unsupportedKeys = Object.keys(body).filter((key) => !allowedSettingsPaths.has(key))
            if (unsupportedKeys.length > 0) {
              json(res, { error: 'Unsupported setting path', details: unsupportedKeys }, 400)
              return
            }

            const errors: string[] = []
            for (const [section, validator] of Object.entries(sectionValidators)) {
              const value = body[section]
              if (value !== undefined) {
                const result = validator.safeParse(value)
                if (!result.success) {
                  for (const issue of result.error!.issues) {
                    const path = issue.path.length ? `${section}.${issue.path.map(String).join('.')}` : section
                    errors.push(`${path}: ${issue.message}`)
                  }
                }
              }
            }

            if (Array.isArray(body['registry.llms'])) {
              for (const [idx, item] of (body['registry.llms'] as unknown[]).entries()) {
                const result = NamedLLMConfigSchema.safeParse(item)
                if (!result.success) {
                  for (const issue of result.error!.issues) {
                    const p = issue.path.length ? `registry.llms[${idx}].${issue.path.join('.')}` : `registry.llms[${idx}]`
                    errors.push(`${p}: ${issue.message}`)
                  }
                }
              }
            }

            if (errors.length > 0) {
              json(res, { error: 'Validation failed', details: errors }, 400)
              return
            }

            for (const section of objectSections) {
              if (body[section] && typeof body[section] === 'object') {
                await configManager.replaceSection(section, body[section] as Record<string, unknown>)
              }
            }
            for (const section of arraySections) {
              if (body[section] !== undefined) {
                await configManager.replaceSectionRaw(section, body[section])
              }
            }
            for (const section of scalarSections) {
              if (body[section] !== undefined) {
                await configManager.replaceSectionRaw(section, body[section])
              }
            }
            if (currentHasRootHeadless || requestHasRootHeadless) {
              await configManager.deleteSectionRaw('use.headless')
            }
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update settings' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
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
          ;(async () => {
            try {
              await removeAuth(providerName)
              json(res, { deleted: true })
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
                json(res, { error: target.error }, 400)
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
                    await writeDashboardAuth(target.configName, {
                      type: 'oauth',
                      provider: plugin.credentialProviderId,
                      tokens,
                    })
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
              await writeDashboardAuth(session.configName, {
                type: 'oauth',
                provider: session.credentialProviderId,
                tokens,
              })
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
            const target = await requireCredentialConfig(configManager, body.configName, provider)
            if (!target.ok) {
              json(res, { error: target.error }, 400)
              return
            }

            if (credentialType === 'bearer-token') {
              await writeDashboardAuth(target.configName, { type: 'bearer', provider, token: secret })
            } else {
              await writeDashboardAuth(target.configName, { type: 'api', provider, key: secret })
            }
            json(res, { saved: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to save credential' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
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
          if (body.providerHeaders !== undefined) {
            llmCandidate.providerHeaders = body.providerHeaders
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

          const modelConfig: Record<string, unknown> = { ...llmConfig }
          let unauthenticated = false
          let authMessage: string | undefined

          if (resolvedAuth.kind === 'api-key') {
            modelConfig.apiKey = resolvedAuth.apiKey
          } else if (resolvedAuth.kind === 'bearer-token') {
            modelConfig.authToken = resolvedAuth.token
          } else if (resolvedAuth.kind === 'auth-fetch') {
            modelConfig.fetch = resolvedAuth.fetch
            modelConfig.modelAdapter = resolvedAuth.modelAdapter
          } else if (resolvedAuth.kind === 'unauthenticated') {
            unauthenticated = true
            authMessage = resolvedAuth.message
          }

          try {
            const { createModel } = await import('@vostride/agent-qa-core')
            const model = await createModel(modelConfig as unknown as Parameters<typeof createModel>[0])

            const testProviderOpts = getProviderOptions(modelConfig as unknown as Parameters<typeof getProviderOptions>[0])
            const connectionTimeoutMs = llmConnectionTestTimeoutMs(llmConfig)

            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), connectionTimeoutMs)
            try {
              const { generateText } = await import('ai')
              await generateText({
                model,
                prompt: 'Say "ok"',
                abortSignal: controller.signal,
                providerOptions: testProviderOpts,
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
              ...(unauthenticated ? { unauthenticated: true, message: authMessage ?? LLM_TEST_UNAUTHENTICATED_MESSAGE } : {}),
            })
          } catch (err: unknown) {
            const connectionTimeoutMs = llmConnectionTestTimeoutMs(llmConfig)
            const { message: providerMessage, statusCode } = extractProviderErrorMessage(err)
            const errorCategory = classifyProviderError(providerMessage, statusCode)
            const message = publicLLMTestMessage(errorCategory, providerMessage)

            json(res, {
              success: false,
              error: errorCategory,
              message,
              timeoutMs: connectionTimeoutMs,
              ...(statusCode ? { statusCode } : {}),
              ...(message !== providerMessage ? { details: providerMessage } : {}),
              ...(unauthenticated ? { unauthenticated: true, authMessage: authMessage ?? LLM_TEST_UNAUTHENTICATED_MESSAGE } : {}),
            })
          }
        })
        .catch(() => json(res, { success: false, error: 'invalid_request', message: 'Invalid request body' }, 400))
      return
    }

    // POST /api/cache/purge — purge cached action plans for a test or all tests
    if (path === '/api/cache/purge' && req.method === 'POST') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 503)
        return
      }
      readJsonBody<{ file?: string; all?: boolean }>(req)
        .then(async (body) => {
          if (!body.file && !body.all) {
            json(res, { error: 'Either file or all is required' }, 400)
            return
          }
          try {
            const cfg = await configManager.read()
            const targetPlatforms = getTargetPlatformMap(cfg)
            const cacheDir = (cfg as {
              services?: { cache?: { dir?: string } }
              cache?: { dir?: string }
            }).services?.cache?.dir
              ?? (cfg as { cache?: { dir?: string } }).cache?.dir
            if (!cacheDir) {
              json(res, { error: 'Cache directory not configured' }, 400)
              return
            }
            if (body.file) {
              // Read raw config file content for cache key scoping
              let configContent = ''
              if (deps.configPath) {
                try { configContent = await readFile(deps.configPath, 'utf-8') } catch { /* best-effort */ }
              }
              const resolvedPath = (await normalizeDashboardWorkspacePath(body.file, workspacePaths, 'test')).executionPath
              const content = await readFile(resolvedPath, 'utf-8')
              const doc = parseYaml(content)
              const metadata = extractTestFileMetadata(content)
              const platform = resolveEffectivePlatform(
                metadata.platform,
                metadata.targetName,
                targetPlatforms,
                'web',
              ) ?? 'web'
              const steps: string[] = (doc.steps ?? []).map((s: unknown) =>
                typeof s === 'string' ? s : (s as Record<string, string>).step,
              )
              const configDir = deps.configPath ? dirname(resolve(deps.configPath)) : process.cwd()
              const resolvedCacheDir = resolve(configDir, cacheDir)
              let purged = 0
              for (const step of steps) {
                const stepHash = hashStepInstruction(step, platform, configContent, content)
                const dirPath = join(resolvedCacheDir, stepHash)
                try {
                  await stat(dirPath)
                  await rm(dirPath, { recursive: true, force: true })
                  purged++
                } catch {
                  // directory doesn't exist — skip
                }
              }
              json(res, { purged })
            } else {
              const configDir = deps.configPath ? dirname(resolve(deps.configPath)) : process.cwd()
              const resolvedDir = resolve(configDir, cacheDir)
              let entries: string[]
              try {
                entries = await readdir(resolvedDir)
              } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                  json(res, { purged: 0 })
                  return
                }
                throw err
              }
              for (const entry of entries) {
                await rm(join(resolvedDir, entry), { recursive: true, force: true })
              }
              json(res, { purged: entries.length })
            }
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Cache purge failed' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // Agent Rules API
    if (path === '/api/agent-rules' && req.method === 'GET') {
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
            content = await readFile(workspacePaths.agentRules.absolutePath, 'utf-8')
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              json(res, { content: null, filePath: workspacePaths.agentRules.workspaceRelativePath, error: 'workspace.agentRules file_not_found' }, 500)
              return
            }
            throw err
          }
          json(res, { content, filePath: workspacePaths.agentRules.workspaceRelativePath })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read agent rules' }, 500)
        }
      })()
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

            const workspaceEnv = await readWorkspaceEnvVars(workspacePaths)
            const result = await runHookInSandbox(resolvedHook, {
              envVars: {
                ...workspaceEnv,
                ...validation.overrides,
              },
            })
            const networkLogs = summarizeHookNetworkLogs(
              (result as { networkLogs?: Array<{ url: string; method: string; status: number; startTime: number; endTime: number }> }).networkLogs,
            )

            json(res, sanitizeAuthStateForResponse({
              success: result.success,
              status: result.success ? 'passed' : 'failed',
              executedAt: new Date().toISOString(),
              duration: result.duration,
              output: result.output,
              stdout: result.stdout,
              stderr: result.stderr,
              error: result.error ?? null,
              variables: result.variables,
              sandbox: {
                runtime: resolvedHook.runtime,
                image: RUNTIME_IMAGE_MAP[resolvedHook.runtime],
                networkMode: resolvedHook.network ? 'enabled' : 'disabled',
                dockerVersion: null,
                networkLogsAvailable: networkLogs.length > 0,
                networkLogs,
              },
            } satisfies import('../hooks/hook-registry-types.js').HookRunResponse))
          } catch (err: unknown) {
            json(res, sanitizeAuthStateForResponse({ error: err instanceof Error ? err.message : 'Failed to run hook' }), 500)
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

    if (path === '/api/agent-rules' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<{ content: string }>(req)
        .then(async (body) => {
          try {
            if (typeof body.content !== 'string') {
              json(res, { error: 'Missing required field: content' }, 400)
              return
            }
            if (!workspacePaths) {
              json(res, { error: 'Workspace path resolution not available' }, 503)
              return
            }
            await writeFile(workspacePaths.agentRules.absolutePath, body.content, 'utf-8')
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to save agent rules' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    if (path === '/api/agent-rules/create' && req.method === 'POST') {
      if (!configManager || !deps.configPath) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      const configPath = deps.configPath
      readJsonBody<{ fileName?: string }>(req)
        .then(async (body) => {
          try {
            const fileName = typeof body.fileName === 'string' && body.fileName.trim()
              ? body.fileName.trim()
              : 'agent-rules.md'
            if (!isPlainFileName(fileName)) {
              json(res, { error: 'fileName must be a plain file name' }, 400)
              return
            }

            const configDir = dirname(configPath)
            const resolvedPath = resolve(configDir, fileName)
            if (!getPathInsideDir(resolvedPath, configDir)) {
              json(res, { error: 'Invalid agent rules path' }, 400)
              return
            }

            await writeFile(resolvedPath, '', { encoding: 'utf-8', flag: 'wx' })
            await configManager!.replaceSectionRaw('workspace.agentRules', `./${fileName}`)
            json(res, { created: true, filePath: `./${fileName}` })
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
              json(res, { error: 'Agent rules file already exists' }, 409)
              return
            }
            json(res, { error: err instanceof Error ? err.message : 'Failed to create agent rules file' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
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
            notFound(res, 'Session not found')
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
          let agentRules: string | undefined
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
            agentRules = await readFile(workspacePaths.agentRules.absolutePath, 'utf-8')
          } catch {
            json(res, { error: `workspace.agentRules file could not be loaded: ${workspacePaths.agentRules.workspaceRelativePath}` }, 400)
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
          const { sessionId, sessionNumber } = await sessionManager.createSession(
            {
              platform: platform as 'web' | 'android' | 'ios',
              targetName: typeof body?.targetName === 'string' ? body.targetName : undefined,
              llmConfig: runtimeLLM.llmConfig,
              authFetch: runtimeLLM.authFetch,
              agentRules,
              envVars,
              secretStore,
              secretRedactor,
              setupHooks,
              teardownHooks,
              resolvedHooks,
              hookRegistryError,
              url: body?.url,
              headless: body?.headless ?? false,
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
          json(res, { error: message }, 500)
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
          notFound(res, 'Session not found')
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

    // Variable suggestions: captured variable names from prior runs
    const capturedMatch = path.match(/^\/api\/variables\/captured\/([^/]+)$/)
    if (capturedMatch && req.method === 'GET') {
      ;(async () => {
        try {
          const testId = decodeURIComponent(capturedMatch[1])
          const names = db.getCapturedVariableNames(testId)
          json(res, { names })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read captured variables' }, 500)
        }
      })()
      return
    }

    if (path === '/api/memory/catalog' && req.method === 'GET') {
      ;(async () => {
        try {
          json(res, await memoryCatalogManager.readCatalog())
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read memory catalog' }, 500)
        }
      })()
      return
    }

    const memoryProductMatch = path.match(/^\/api\/memory\/products\/([^/]+)$/)
    if (memoryProductMatch && req.method === 'GET') {
      ;(async () => {
        try {
          const productKey = decodeURIComponent(memoryProductMatch[1])
          if (!isValidMemoryScopeId(productKey)) {
            json(res, { error: 'Invalid memory product id' }, 400)
            return
          }
          const product = await memoryCatalogManager.readProductDetail(productKey)
          if (!product) {
            json(res, { error: 'Memory product not found' }, 404)
            return
          }
          json(res, { product })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read memory product' }, 500)
        }
      })()
      return
    }

    const memoryScopeMatch = path.match(/^\/api\/memory\/scopes\/([^/]+)\/([^/]+)$/)
    if (memoryScopeMatch && req.method === 'GET') {
      ;(async () => {
        try {
          const scope = decodeURIComponent(memoryScopeMatch[1])
          const scopeId = decodeURIComponent(memoryScopeMatch[2])
          if (!isMemoryScope(scope)) {
            json(res, { error: 'Invalid memory scope' }, 400)
            return
          }
          if (!isValidMemoryScopeId(scopeId)) {
            json(res, { error: 'Invalid memory scope id' }, 400)
            return
          }
          const payload = await memoryCatalogManager.readScopedObservations(scope, scopeId)
          if (!payload) {
            json(res, { error: 'Memory scope not found' }, 404)
            return
          }
          json(res, payload)
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read memory scope' }, 500)
        }
      })()
      return
    }

    // Memory observations: list for a test
    const obsListMatch = path.match(/^\/api\/memory\/observations\/([^/]+)$/)
    if (obsListMatch && req.method === 'GET') {
      ;(async () => {
        try {
          const testId = decodeURIComponent(obsListMatch[1])
          const payload = await memoryCatalogManager.readScopedObservations('test', testId)
          json(res, {
            observations: payload?.observations ?? [],
            invalidFiles: payload?.invalidFiles ?? [],
          })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read observations' }, 500)
        }
      })()
      return
    }

    // Memory observations: delete
    const obsDeleteMatch = path.match(/^\/api\/memory\/observations\/([^/]+)\/([^/]+)$/)
    if (obsDeleteMatch && req.method === 'DELETE') {
      ;(async () => {
        try {
          const testId = decodeURIComponent(obsDeleteMatch[1])
          const obsId = decodeURIComponent(obsDeleteMatch[2])
          if (!isValidMemoryScopeId(testId) || !isValidMemoryScopeId(obsId)) {
            json(res, { error: 'Invalid memory observation id' }, 400)
            return
          }

          const configDir = deps.configPath ? dirname(resolve(deps.configPath)) : process.cwd()
          const cfg = configManager ? await configManager.read().catch(() => undefined) : undefined
          const parsedConfig = AgentQaConfigSchema.safeParse(cfg ?? {})
          const memoryRoot = parsedConfig.success
            ? resolveMemoryRoot(parsedConfig.data, configDir)
            : resolveMemoryRoot(undefined, configDir)
          const testsRoot = join(memoryRoot, 'tests')
          const resolved = resolve(testsRoot, testId, `${obsId}.md`)
          if (!getPathInsideDir(resolved, testsRoot)) {
            json(res, { error: 'Invalid path' }, 400)
            return
          }

          await rm(resolved, { force: true })
          json(res, { deleted: true })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to delete observation' }, 500)
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

function isMemoryScope(value: string): value is MemoryScope {
  return value === 'product' || value === 'suite' || value === 'test'
}
