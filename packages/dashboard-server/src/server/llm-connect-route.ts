// Only a passing test or an explicit `skipTest` writes the credential and definition; never echoed.
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  getLLMAuthProviderPlugin,
  ModelConfigSchema,
  NameSlugSchema,
  readAuth,
  removeAuth,
  resolveLLMAuth,
  writeAuth,
  type AuthCredential,
} from '@vostride/agent-qa-core'
import { createModel, getProvider, type ResolvedModelAuth } from '@vostride/agent-qa-model'
import {
  classifyProviderError,
  extractProviderError,
  LlmConnectRequestSchema,
  providerErrorSentence,
  type ConfigChange,
  type LlmConnectRequest,
  type LlmConnectResult,
} from '@vostride/agent-qa-schema'

import type { ConfigManager } from '../config/index.js'
import {
  authFromFetch,
  authFromRuntimeConfig,
  toModelProfileAndAuth,
  type DashboardLLMConfig,
} from '../llm-model-mapping.js'
import { respondJson } from '../run-service/run-detail-routes.js'
import { readJsonBody } from './body-parser.js'

export interface LlmConnectDeps {
  readonly configManager: ConfigManager
  /** The router's one queue for every auth.json write and removal. */
  readonly withCredentialLock: <T>(work: () => Promise<T>) => Promise<T>
  /** The product provider an auth.json entry belongs to, mapped as GET /api/auth/status maps it. */
  readonly credentialProvider: (name: string, credential: AuthCredential) => string
  /** The test route's probe budget for this model. */
  readonly connectionTimeoutMs: (config: { provider?: unknown; baseURL?: unknown }) => number
  /** The router's names with a connect in flight: a second connect for one answers name_taken at once. */
  readonly inFlight: Set<string>
}

/** One set per router, shared by every connect it answers. */
export function createConnectInFlight(): Set<string> {
  return new Set<string>()
}

type Answer = { readonly status: number; readonly body: unknown }

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): Answer => ({
  status,
  body: { error, ...extra },
})

const COMPATIBLE_KEY_PROVIDERS = new Set(['openai-compatible', 'anthropic-compatible', 'gemini'])
const REDACTED = '[redacted]'

function isKnownProvider(provider: string): boolean {
  return getProvider(provider) !== undefined || getLLMAuthProviderPlugin(provider) !== undefined
}

function isSubscriptionProvider(provider: string): boolean {
  return getLLMAuthProviderPlugin(provider) !== undefined || getProvider(provider)?.subscription === true
}

// The same rules POST /api/auth/credential applies to a typed secret.
function credentialAccepted(provider: string, type: 'api-key' | 'bearer-token'): boolean {
  if (isSubscriptionProvider(provider)) return false
  if (type === 'bearer-token') return provider === 'anthropic-compatible'
  return COMPATIBLE_KEY_PROVIDERS.has(provider)
}

function ownEntry(store: Record<string, AuthCredential | undefined>, name: string): AuthCredential | undefined {
  return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : undefined
}

function registryNames(config: Record<string, unknown>): string[] {
  const registry = config.registry as { llms?: unknown } | undefined
  const llms = Array.isArray(registry?.llms) ? registry.llms : []
  return llms.flatMap((item) => {
    const name = (item as { name?: unknown } | null)?.name
    return typeof name === 'string' ? [name] : []
  })
}

function hasValidDefault(config: Record<string, unknown>): boolean {
  const selected = (config.use as { llm?: unknown } | undefined)?.llm
  return typeof selected === 'string' && registryNames(config).includes(selected)
}

type ConfigState = { kind: 'ok'; config: Record<string, unknown> } | { kind: 'file_invalid' }

async function readConfig(configManager: ConfigManager): Promise<ConfigState> {
  const read = await configManager.readWithRevision()
  if (read.kind === 'file_invalid') return { kind: 'file_invalid' }
  return { kind: 'ok', config: read.kind === 'ok' ? read.config : {} }
}

function withoutSecret(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join(REDACTED) : text
}

function toStoredCredential(
  provider: string,
  credential: NonNullable<LlmConnectRequest['credential']>,
): AuthCredential {
  return credential.type === 'bearer-token'
    ? { type: 'bearer', provider, token: credential.secret }
    : { type: 'api', provider, key: credential.secret }
}

type ResolvedTestAuth =
  | { kind: 'ok'; auth: ResolvedModelAuth; usedCredential: boolean }
  | { kind: 'missing' }

// A typed secret is used inline; otherwise the saved credential or the draft's completed sign-in.
async function resolveTestAuth(
  name: string,
  provider: string,
  llmConfig: DashboardLLMConfig,
  credential: LlmConnectRequest['credential'],
): Promise<ResolvedTestAuth> {
  if (credential) {
    const auth = authFromRuntimeConfig(
      credential.type === 'api-key' ? { apiKey: credential.secret } : { authToken: credential.secret },
    )
    return { kind: 'ok', auth, usedCredential: true }
  }
  const resolved = await resolveLLMAuth(name, llmConfig)
  switch (resolved.kind) {
    case 'api-key':
      return { kind: 'ok', auth: authFromRuntimeConfig({ apiKey: resolved.apiKey }), usedCredential: true }
    case 'bearer-token':
      return { kind: 'ok', auth: authFromRuntimeConfig({ authToken: resolved.token }), usedCredential: true }
    case 'auth-fetch':
      return {
        kind: 'ok',
        auth: authFromRuntimeConfig({}, authFromFetch(provider, resolved.fetch)),
        usedCredential: true,
      }
    case 'unauthenticated':
    case 'missing':
      if (getProvider(provider)?.credentialOptional === true) {
        return { kind: 'ok', auth: { kind: 'none' }, usedCredential: false }
      }
      return { kind: 'missing' }
  }
}

async function probe(
  llmConfig: DashboardLLMConfig,
  auth: ResolvedModelAuth,
  timeoutMs: number,
): Promise<void> {
  const { profile, auth: modelAuth } = toModelProfileAndAuth(llmConfig, auth)
  // Fixed probe text, nothing to mask.
  const model = createModel(profile, modelAuth, (text) => text)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { generateText } = await import('ai')
    await generateText({ model, prompt: 'Say "ok"', abortSignal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function connectLlm(raw: unknown, deps: LlmConnectDeps): Promise<Answer> {
  const parsed = LlmConnectRequestSchema.safeParse(raw)
  if (!parsed.success) return refuse(400, 'invalid_setup_input')
  const request = parsed.data
  const { name } = request
  if (!NameSlugSchema.safeParse(name).success) return refuse(400, 'name_invalid')
  if (deps.inFlight.has(name)) return refuse(409, 'name_taken')
  deps.inFlight.add(name)
  try {
    return await connectName(request, deps)
  } finally {
    deps.inFlight.delete(name)
  }
}

async function connectName(request: LlmConnectRequest, deps: LlmConnectDeps): Promise<Answer> {
  const { name, credential } = request
  const provider = request.provider.trim()
  const modelId = request.model.trim()
  if (!isKnownProvider(provider) || !modelId) return refuse(400, 'invalid_setup_input')
  if (credential && !credentialAccepted(provider, credential.type)) return refuse(400, 'credential_not_accepted')

  const definition: Record<string, unknown> = { provider, model: modelId }
  if (request.baseURL !== undefined) definition.baseURL = request.baseURL
  if (request.providerHeaders !== undefined) definition.providerHeaders = request.providerHeaders
  const candidate = ModelConfigSchema.safeParse(definition)
  if (!candidate.success) {
    return refuse(400, 'invalid_setup_input', {
      issues: candidate.error.issues.map((issue) => ({
        path: issue.path.map((key) => (typeof key === 'number' ? key : String(key))),
        message: issue.message,
      })),
    })
  }
  const llmConfig = candidate.data as DashboardLLMConfig

  const before = await readConfig(deps.configManager)
  if (before.kind === 'file_invalid') return refuse(409, 'file_invalid')
  if (registryNames(before.config).includes(name)) return refuse(409, 'name_taken')

  const existing = ownEntry(await readAuth() as Record<string, AuthCredential | undefined>, name)
  if (existing && deps.credentialProvider(name, existing) !== provider) {
    return refuse(409, 'credential_provider_conflict')
  }

  let usedCredential = credential !== undefined
  if (!request.skipTest) {
    const resolved = await resolveTestAuth(name, provider, llmConfig, credential)
    if (resolved.kind === 'missing') return refuse(400, 'credential_missing')
    usedCredential = resolved.usedCredential
    try {
      await probe(llmConfig, resolved.auth, deps.connectionTimeoutMs(llmConfig))
    } catch (err: unknown) {
      const { message, statusCode } = extractProviderError(err)
      const providerMessage = withoutSecret(message, credential?.secret)
      const errorClass = classifyProviderError(providerMessage, statusCode)
      const failed: LlmConnectResult = {
        success: false,
        errorClass,
        message: providerErrorSentence(errorClass, providerMessage),
      }
      return { status: 200, body: failed }
    }
  }

  return deps.withCredentialLock(async () => {
    const current = await readConfig(deps.configManager)
    if (current.kind === 'file_invalid') return refuse(409, 'file_invalid')
    if (registryNames(current.config).includes(name)) return refuse(409, 'name_taken')

    let previous: AuthCredential | undefined
    let wroteCredential = false
    if (credential) {
      previous = ownEntry(await readAuth() as Record<string, AuthCredential | undefined>, name)
      if (previous && deps.credentialProvider(name, previous) !== provider) {
        return refuse(409, 'credential_provider_conflict')
      }
      await writeAuth(name, toStoredCredential(provider, credential))
      wroteCredential = true
    }
    // A credential this request created goes; one that was there before gets its old value back.
    const undoCredential = async (): Promise<void> => {
      if (!wroteCredential) return
      if (previous) await writeAuth(name, previous)
      else await removeAuth(name)
    }

    const becameDefault = !hasValidDefault(current.config)
    const changes: ConfigChange[] = [
      { op: 'append', path: ['registry', 'llms'], value: { name, ...definition } },
      ...(becameDefault ? [{ op: 'set' as const, path: ['use', 'llm'], value: name }] : []),
    ]
    let outcome: Awaited<ReturnType<ConfigManager['applyChanges']>>
    try {
      outcome = await deps.configManager.applyChanges(changes)
    } catch (err: unknown) {
      await undoCredential()
      throw err
    }
    if (outcome.kind !== 'ok') {
      await undoCredential()
      if (outcome.error === 'file_invalid') return refuse(409, 'file_invalid')
      return refuse(422, outcome.error, outcome.issues === undefined ? {} : { issues: outcome.issues })
    }
    const saved: LlmConnectResult = {
      success: true,
      saved: true,
      becameDefault,
      usedCredential,
      revision: outcome.revision,
    }
    return { status: 200, body: saved }
  })
}

/** POST /api/llm/connect. The body is an LlmConnectRequest; the answer is an LlmConnectResult or a named refusal. */
export function registerLlmConnectRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LlmConnectDeps,
): void {
  void readJsonBody<unknown>(req).then(async (body) => {
    const answer = await connectLlm(body, deps)
    respondJson(res, answer.status, answer.body)
  }, () => { respondJson(res, 400, { error: 'invalid_setup_input' }) })
    .catch(() => { respondJson(res, 500, { error: 'connect_failed' }) })
}
