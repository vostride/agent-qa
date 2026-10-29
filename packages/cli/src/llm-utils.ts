import { dirname, resolve as resolvePath } from 'node:path'
import { createModel, createTokenAccounting, getProviderOptions, resolveCapabilities, resolveVisionGate } from '@vostride/agent-qa-model'
import { generateText } from 'ai'
import { createDeclaredSecretMask } from './composition/declared-secrets.js'
import { DEFAULT_ANTHROPIC_MODEL } from './model-defaults.js'
import { loadProviderPluginsForRawConfig } from './provider-plugins.js'

import type { ChatLanguageModel, JobModelCapability } from '@vostride/agent-qa-agent'
import type { MaskFn } from '@vostride/agent-qa-schema'
import type { ModelAuthDeclaration, ModelProfile, ResolvedModelAuth, TokenAccounting } from '@vostride/agent-qa-model'

export { loadProviderPluginsForRawConfig }

export type BuiltInLLMProviderMode =
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'openai-subscription'
  | 'anthropic-subscription'
  | 'gemini'

export type LLMProviderMode = BuiltInLLMProviderMode | (string & {})

export type LLMModelAdapter = 'openai-responses' | 'anthropic-messages'

export type ResolvedLLMAuth =
  | { kind: 'api-key'; credentialKey: string; provider: BuiltInLLMProviderMode; apiKey: string }
  | { kind: 'bearer-token'; credentialKey: string; provider: 'anthropic-compatible'; token: string }
  | {
    kind: 'auth-fetch'
    credentialKey: string
    provider: string
    modelAdapter: LLMModelAdapter
    fetch: typeof globalThis.fetch
    expires?: number
  }
  | {
    kind: 'unauthenticated'
    credentialKey: string
    provider: 'openai-compatible' | 'anthropic-compatible'
    optional: true
    message: string
  }
  | {
    kind: 'missing'
    credentialKey: string
    provider: string
    required: true
    message: string
  }

export type LLMConfigLike = {
  provider: LLMProviderMode
  model: string
  baseURL?: string
  providerHeaders?: Record<string, string>
  vision?: boolean
  contextWindow?: number
}

export type NamedLLMConfigLike = LLMConfigLike & {
  name: string
}

export type RuntimeModelConfigLike = LLMConfigLike & {
  apiKey?: string
  authToken?: string
  fetch?: typeof globalThis.fetch
  modelAdapter?: LLMModelAdapter
  contextWindow?: number
}

function normalizeLLMConfig(raw: NamedLLMConfigLike & Record<string, unknown>): NamedLLMConfigLike {
  return {
    name: raw.name,
    provider: raw.provider,
    model: raw.model,
    ...(raw.baseURL !== undefined ? { baseURL: raw.baseURL } : {}),
    ...(raw.providerHeaders !== undefined ? { providerHeaders: raw.providerHeaders } : {}),
    ...(raw.vision !== undefined ? { vision: raw.vision } : {}),
    ...(raw.contextWindow !== undefined ? { contextWindow: raw.contextWindow } : {}),
  }
}

export async function loadAuthPluginsForRawConfig(raw: unknown, configPath = 'agent-qa.config.yaml'): Promise<void> {
  const declarations = (raw as { plugins?: { auth?: unknown } } | null)?.plugins?.auth
  if (!Array.isArray(declarations) || declarations.length === 0) return

  const { loadLLMAuthPlugins } = await import('@vostride/agent-qa-core')
  await loadLLMAuthPlugins(declarations as Parameters<typeof loadLLMAuthPlugins>[0], {
    baseDir: dirname(resolvePath(configPath)),
  })
}

export async function resolveNamedConfig(
  configName?: string,
  configPath = 'agent-qa.config.yaml',
  options: { keyOnly?: boolean } = {},
): Promise<{
  config: NamedLLMConfigLike
  allConfigs: NamedLLMConfigLike[]
  defaultName: string
}> {
  const { loadConfigFile } = await import('./config.js')
  const raw = (await loadConfigFile(configPath)) as Record<string, unknown> | null
  if (options.keyOnly !== true) {
    await loadAuthPluginsForRawConfig(raw, configPath)
    await loadProviderPluginsForRawConfig(raw, configPath)
  }
  const llms = ((raw as any)?.registry?.llms as Array<NamedLLMConfigLike & Record<string, unknown>> | undefined)
    ?.map(normalizeLLMConfig)
  const defaultLLM = (raw as any)?.use?.llm as string | undefined

  if (!llms?.length) {
    throw new Error('No LLM configs found. Run `agent-qa init` to set up your config.')
  }

  const targetName = configName ?? defaultLLM
  if (!targetName) {
    throw new Error('No config name specified and no use.llm set in config.')
  }

  const found = llms.find(c => c.name === targetName)
  if (!found) {
    throw new Error(`Config "${targetName}" not found. Available: ${llms.map(c => c.name).join(', ')}`)
  }

  return { config: found, allConfigs: llms, defaultName: defaultLLM ?? '' }
}

export function resolveLLMModels(config: {
  registry?: { llms?: NamedLLMConfigLike[] }
  use?: { llm?: string }
}): {
  planner: LLMConfigLike
  verifier: LLMConfigLike
  configName: string
} {
  const defaults: LLMConfigLike = { provider: 'anthropic-subscription', model: DEFAULT_ANTHROPIC_MODEL }
  if (!config.registry?.llms || !config.use?.llm) {
    return { planner: defaults, verifier: defaults, configName: '' }
  }
  const found = config.registry.llms.find(c => c.name === config.use!.llm)
  if (!found) {
    return { planner: defaults, verifier: defaults, configName: '' }
  }
  const { name, ...modelFields } = normalizeLLMConfig(found as NamedLLMConfigLike & Record<string, unknown>)
  return { planner: modelFields, verifier: modelFields, configName: name }
}

export async function resolveModelAuth(
  configName: string,
  llmConfig: LLMConfigLike,
): Promise<ResolvedLLMAuth> {
  const { resolveLLMAuth } = await import('@vostride/agent-qa-core') as unknown as {
    resolveLLMAuth: (configName: string, llmConfig: LLMConfigLike) => Promise<ResolvedLLMAuth>
  }
  return resolveLLMAuth(configName, llmConfig)
}

export function applyResolvedAuthToModelConfig(
  llmConfig: LLMConfigLike,
  auth: ResolvedLLMAuth,
): RuntimeModelConfigLike {
  switch (auth.kind) {
    case 'api-key':
      return { ...llmConfig, apiKey: auth.apiKey }
    case 'bearer-token':
      return { ...llmConfig, authToken: auth.token }
    case 'auth-fetch':
      return { ...llmConfig, fetch: auth.fetch, modelAdapter: auth.modelAdapter }
    case 'unauthenticated':
      return { ...llmConfig }
    case 'missing':
      throw new Error(auth.message)
  }
}

export function toModelProfileAndAuth(
  llmConfig: LLMConfigLike,
  resolved: ResolvedLLMAuth,
): { profile: ModelProfile; auth: ResolvedModelAuth } {
  const providerOptions = getProviderOptions({
    provider: llmConfig.provider,
    modelAdapter: resolved.kind === 'auth-fetch' ? resolved.modelAdapter : undefined,
    fetch: resolved.kind === 'auth-fetch' ? resolved.fetch : undefined,
  })

  const profile: ModelProfile = {
    provider: llmConfig.provider,
    model: llmConfig.model,
    ...(llmConfig.baseURL !== undefined ? { baseURL: llmConfig.baseURL } : {}),
    ...(llmConfig.providerHeaders !== undefined ? { headers: llmConfig.providerHeaders } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    auth: toAuthDeclaration(resolved),
  }

  switch (resolved.kind) {
    case 'api-key':
      return { profile, auth: { kind: 'api-key', apiKey: resolved.apiKey } }
    case 'bearer-token':
      return { profile, auth: { kind: 'bearer-token', token: resolved.token } }
    case 'auth-fetch':
      return { profile, auth: { kind: 'auth-fetch', modelAdapter: resolved.modelAdapter, fetch: resolved.fetch } }
    case 'unauthenticated':
      return { profile, auth: { kind: 'none' } }
    case 'missing':
      throw new Error(resolved.message)
  }
}

function toAuthDeclaration(resolved: ResolvedLLMAuth): ModelAuthDeclaration {
  switch (resolved.kind) {
    case 'api-key':
      return { mode: 'api-key' }
    case 'bearer-token':
      return { mode: 'bearer-token' }
    case 'auth-fetch':
      return { mode: 'subscription', plugin: resolved.provider }
    case 'unauthenticated':
    case 'missing':
      return { mode: 'none' }
  }
}

/** Focused test seam for `buildJobModelCapability`. Production callers omit it. */
export interface JobModelCapabilityDeps {
  createModelImpl?: typeof createModel
  createTokenAccountingImpl?: typeof createTokenAccounting
  resolveCapabilitiesImpl?: typeof resolveCapabilities
  generateTextImpl?: typeof generateText
}

// Zero temperature and no retries, so an authored checkpoint records a deterministic answer.
export function buildJobModelCapability(
  profile: ModelProfile,
  auth: ResolvedModelAuth,
  mask: MaskFn,
  deps: JobModelCapabilityDeps = {},
): JobModelCapability {
  const model = (deps.createModelImpl ?? createModel)(profile, auth, mask)
  const accounting = (deps.createTokenAccountingImpl ?? createTokenAccounting)({
    getCapabilities: () => (deps.resolveCapabilitiesImpl ?? resolveCapabilities)(profile),
  })
  const generate = deps.generateTextImpl ?? generateText
  // The vision gate is enforced here, at the host boundary, even when a caller mis-gates.
  const vision = (deps.resolveCapabilitiesImpl ?? resolveCapabilities)(profile).vision

  return {
    modelId: `${profile.provider}:${profile.model}`,
    vision,
    async generate(request) {
      const base = {
        model,
        maxRetries: 0,
        temperature: 0,
        maxOutputTokens: accounting.getCeilings().maxOutput,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
      }
      // Images ride the prompt's request only when the gate allows; text-only calls stay plain.
      if (
        request.images !== undefined
        && request.images.length > 0
        && resolveVisionGate({ vision }).attachImage
      ) {
        const result = await generate({
          ...base,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text' as const, text: request.prompt },
                ...request.images.map((image) => ({ type: 'image' as const, image })),
              ],
            },
          ],
        })
        return { text: result.text }
      }
      const result = await generate({
        ...base,
        prompt: request.prompt,
      })
      return { text: result.text }
    },
  }
}

// Estimator and budget read the same `resolveCapabilities(profile)` as the ceiling, so they agree.
export function buildAnalysisTokenBudget(
  profile: ModelProfile,
  deps: JobModelCapabilityDeps = {},
): { readonly estimate: (text: string) => number; readonly inputBudget: number } {
  const accounting = (deps.createTokenAccountingImpl ?? createTokenAccounting)({
    getCapabilities: () => (deps.resolveCapabilitiesImpl ?? resolveCapabilities)(profile),
  })
  const ceilings = accounting.getCeilings()
  return {
    estimate: (text: string) => accounting.estimate([{ role: 'user', content: text }]),
    inputBudget: Math.max(0, ceilings.contextWindow - ceilings.maxOutput),
  }
}

// Degrades to `undefined`: with no usable LLM the queue still drains and the author has no ladder.
export async function resolveCliAnalysisTokenBudget(
  configPath: string,
  deps: JobModelCapabilityDeps = {},
): Promise<{ readonly estimate: (text: string) => number; readonly inputBudget: number } | undefined> {
  try {
    const { config } = await resolveNamedConfig(undefined, configPath)
    const resolved = await resolveModelAuth(config.name, config)
    const { profile } = toModelProfileAndAuth(config, resolved)
    return buildAnalysisTokenBudget(profile, deps)
  } catch {
    return undefined
  }
}

/**
 * The CLI's job-authorship capability, resolved from the project's configured default LLM.
 *
 * Called at most once per process, and only when a host actually opens the job queue — the
 * composition root takes it as a factory precisely so `agent-qa fn --list` never pays for an auth
 * resolution or brings a provider handle into existence.
 */
export async function resolveCliJobModel(
  configPath: string,
  deps: JobModelCapabilityDeps = {},
): Promise<JobModelCapability> {
  const { config } = await resolveNamedConfig(undefined, configPath)
  const resolved = await resolveModelAuth(config.name, config)
  const { profile, auth } = toModelProfileAndAuth(config, resolved)
  return buildJobModelCapability(profile, auth, createDeclaredSecretMask(configPath).mask, deps)
}

// Model, accounting and `/model` resolver come from one named-config resolution.
export interface CliChatCapabilities {
  readonly model: ChatLanguageModel
  readonly accounting: TokenAccounting
  /**
   * `/model <name>` resolves a NAMED config from `registry.llms`, not a bare provider model id.
   * The named config is the vocabulary a person already has in their config file, and it is the
   * only one carrying the auth this host can resolve.
   */
  readonly modelFor: (name: string) => Promise<ChatLanguageModel>
}

// Degrades to `undefined`, composing a headless chat; `agent-local` never constructs a model.
export async function resolveCliChatCapabilities(
  configPath: string,
  deps: JobModelCapabilityDeps = {},
): Promise<CliChatCapabilities | undefined> {
  const { mask } = createDeclaredSecretMask(configPath)
  const build = async (configName?: string): Promise<{
    model: ChatLanguageModel
    accounting: TokenAccounting
  }> => {
    const { config } = await resolveNamedConfig(configName, configPath)
    const resolved = await resolveModelAuth(config.name, config)
    const { profile, auth } = toModelProfileAndAuth(config, resolved)
    return {
      model: (deps.createModelImpl ?? createModel)(profile, auth, mask),
      accounting: (deps.createTokenAccountingImpl ?? createTokenAccounting)({
        getCapabilities: () => (deps.resolveCapabilitiesImpl ?? resolveCapabilities)(profile),
      }),
    }
  }

  try {
    const opened = await build()
    return {
      model: opened.model,
      accounting: opened.accounting,
      // A THROW rather than a degrade on this arm: `/model nonsense` is a person naming something,
      // and the honest answer is the refusal that says which name failed. The turn engine's one
      // refusal path carries it, leaving the same countable row any other refusal leaves.
      modelFor: async (name: string) => (await build(name)).model,
    }
  } catch {
    return undefined
  }
}

export async function resolveCredentials(
  configName: string,
  llmConfig: LLMConfigLike,
): Promise<{ apiKey?: string; authToken?: string; authFetch?: typeof globalThis.fetch }> {
  try {
    const auth = await resolveModelAuth(configName, llmConfig)
    if (auth.kind === 'api-key') return { apiKey: auth.apiKey }
    if (auth.kind === 'bearer-token') return { authToken: auth.token }
    if (auth.kind === 'auth-fetch') return { authFetch: auth.fetch }
    return {}
  } catch {
    return {}
  }
}
