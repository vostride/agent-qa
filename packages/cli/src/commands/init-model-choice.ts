import {
  NameSlugSchema,
  loadLLMAuthPlugins,
  resolveLLMAuth,
  type SavedCredential,
} from '@vostride/agent-qa-core'
import { getProvider } from '@vostride/agent-qa-model'
import { SUBSCRIPTION_AUTH_ENTRY_NAME } from '@vostride/agent-qa-schema'
import { CliRefusal } from '../composition/cli-refusal.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'

export const INIT_MODEL_CHOICES = [
  'claude-code',
  'codex',
  'anthropic',
  'openai',
  'gemini',
  'openai-compatible',
  'anthropic-compatible',
] as const
export type InitModelChoice = (typeof INIT_MODEL_CHOICES)[number]

const INIT_MODEL_CHOICE_TEXT: Record<InitModelChoice, { label: string; hint: string }> = {
  'claude-code': { label: 'Claude subscription (Claude Code)', hint: 'sign in now' },
  codex: { label: 'ChatGPT subscription (Codex)', hint: 'sign in now' },
  anthropic: { label: 'Anthropic API', hint: 'key in the dashboard' },
  openai: { label: 'OpenAI API', hint: 'key in the dashboard' },
  gemini: { label: 'Gemini API', hint: 'key in the dashboard' },
  'openai-compatible': { label: 'OpenAI-compatible endpoint', hint: 'set up in the dashboard' },
  'anthropic-compatible': {
    label: 'Anthropic-compatible endpoint',
    hint: 'set up in the dashboard',
  },
}

// Stored provider → config provider. The stored ids are the subscription-auth plugin's
// `credentialProviderId`s and the built-in API providers; no plugin is loaded at question time.
export const SAVED_PROVIDER_TO_CONFIG: Readonly<Record<string, string>> = {
  'anthropic-subscription': 'anthropic-subscription',
  'openai-subscription-oauth': 'openai-subscription',
  gemini: 'gemini',
  'openai-compatible': 'openai-compatible',
  'anthropic-compatible': 'anthropic-compatible',
}

export type SavedCredentialType = SavedCredential['type']

// A saved pick carries the config provider, already mapped through SAVED_PROVIDER_TO_CONFIG.
export type InitModelPick =
  | { kind: 'new'; choice: InitModelChoice }
  | { kind: 'saved'; name: string; provider: string; type: SavedCredentialType }

type SavedPick = Extract<InitModelPick, { kind: 'saved' }>

export interface InitModelOption {
  value: InitModelPick
  label: string
  hint: string
}

const SAVED_KIND_HINTS: Record<SavedCredentialType, string> = {
  oauth: 'saved · signed in',
  api: 'saved · key saved',
  bearer: 'saved · token saved',
}

function configProviderOf(storedProvider: string): string | undefined {
  return Object.hasOwn(SAVED_PROVIDER_TO_CONFIG, storedProvider)
    ? SAVED_PROVIDER_TO_CONFIG[storedProvider]
    : undefined
}

// Names that fail the config name rule are dropped: a listed name flows into a URL and a command.
function savedPicks(saved: readonly SavedCredential[]): SavedPick[] {
  const picks: SavedPick[] = []
  for (const credential of saved) {
    const provider = configProviderOf(credential.provider)
    if (provider === undefined || !NameSlugSchema.safeParse(credential.name).success) continue
    picks.push({ kind: 'saved', name: credential.name, provider, type: credential.type })
  }
  const rank = (name: string) => (name === 'claude-code' ? 0 : 1)
  return picks.sort(
    (a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

export function initModelOptions(saved: readonly SavedCredential[]): InitModelOption[] {
  const savedOptions = savedPicks(saved).map((pick) => ({
    value: pick,
    label: `${pick.name} (${getProvider(pick.provider)?.label ?? pick.provider})`,
    hint: SAVED_KIND_HINTS[pick.type],
  }))
  const newOptions = INIT_MODEL_CHOICES.map((choice) => ({
    value: { kind: 'new', choice } as const,
    ...INIT_MODEL_CHOICE_TEXT[choice],
  }))
  return [...savedOptions, ...newOptions]
}

interface NewChoiceTarget {
  name: string
  provider: string
  baseURL?: string
  endpoint?: boolean
}

// The base URLs are the official endpoints @ai-sdk/anthropic and @ai-sdk/openai use by default.
const NEW_CHOICE_TARGETS: Record<InitModelChoice, NewChoiceTarget> = {
  'claude-code': { name: 'claude-code', provider: 'anthropic-subscription' },
  codex: { name: 'codex', provider: 'openai-subscription' },
  anthropic: {
    name: 'anthropic',
    provider: 'anthropic-compatible',
    baseURL: 'https://api.anthropic.com/v1',
  },
  openai: { name: 'openai', provider: 'openai-compatible', baseURL: 'https://api.openai.com/v1' },
  gemini: { name: 'gemini', provider: 'gemini' },
  'openai-compatible': { name: 'openai-compatible', provider: 'openai-compatible', endpoint: true },
  'anthropic-compatible': {
    name: 'anthropic-compatible',
    provider: 'anthropic-compatible',
    endpoint: true,
  },
}

// The official endpoint each API choice writes, by provider.
export const INIT_BASE_URL_DEFAULTS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(NEW_CHOICE_TARGETS).flatMap(({ provider, baseURL }) =>
    baseURL === undefined ? [] : [[provider, baseURL]],
  ),
)

// The model page's existing `?add=` choices.
const DASHBOARD_ADD: Readonly<Record<string, string>> = {
  'openai-compatible': 'openai-compatible-key',
  'anthropic-compatible': 'anthropic-compatible-key',
}

export interface InitModelEntry {
  name: string
  provider: string
  model: string
  baseURL?: string
}

export interface InitModelSetup {
  entry?: InitModelEntry
  dashboard?: { add: string; name?: string }
}

export interface InitModelFlags {
  model?: string
  baseUrl?: string
  saved: readonly SavedCredential[]
}

const BASE_URL_FORM_REFUSAL = '--base-url must be an absolute http or https URL'
const ENDPOINT_FLAGS_REFUSAL =
  'an endpoint takes --base-url and --model together, or neither to set it up in the dashboard'
const BASE_URL_PROVIDER_REFUSAL =
  '--base-url applies only to --llm anthropic, openai, openai-compatible or anthropic-compatible'

function needsDashboard(provider: string): boolean {
  return Object.hasOwn(DASHBOARD_ADD, provider)
}

function defaultModelOf(provider: string): string {
  const model = getProvider(provider)?.defaultModel
  if (model === undefined) throw new Error(`No default model is registered for ${provider}`)
  return model
}

function modelFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const model = value.trim()
  if (model === '') throw new CliRefusal(['--model must not be empty'], 2)
  return model
}

function baseUrlFlag(provider: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (getProvider(provider)?.needsBaseURL !== true) {
    throw new CliRefusal([BASE_URL_PROVIDER_REFUSAL], 2)
  }
  const baseUrl = value.trim()
  const url = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
    throw new CliRefusal([BASE_URL_FORM_REFUSAL], 2)
  }
  return baseUrl
}

// A name the store holds for the same provider is shared, so a saved credential is reused and
// never copied; one it holds for another provider is never written over. A compatible key is
// never shared: the store keeps no URL for it, so it could belong to any endpoint, and it is
// reused only when the person picks it.
function freeName(stable: string, provider: string, saved: readonly SavedCredential[]): string {
  const holders = new Map(saved.map((credential) => [credential.name, credential.provider]))
  const fits = (name: string) => {
    const held = holders.get(name)
    if (held === undefined) return true
    return !needsDashboard(provider) && configProviderOf(held) === provider
  }
  if (fits(stable)) return stable
  for (let suffix = 2; ; suffix += 1) {
    if (fits(`${stable}-${suffix}`)) return `${stable}-${suffix}`
  }
}

export function modelEntryFor(pick: InitModelPick, flags: InitModelFlags): InitModelSetup {
  const target: NewChoiceTarget =
    pick.kind === 'new'
      ? NEW_CHOICE_TARGETS[pick.choice]
      : { name: pick.name, provider: pick.provider, endpoint: needsDashboard(pick.provider) }
  const { provider } = target
  const model = modelFlag(flags.model)
  const baseURL = baseUrlFlag(provider, flags.baseUrl)
  const name = () =>
    pick.kind === 'new' ? freeName(target.name, provider, flags.saved) : pick.name

  if (target.endpoint === true) {
    if (model !== undefined && baseURL !== undefined) {
      return { entry: { name: name(), provider, model, baseURL } }
    }
    if (model !== undefined || baseURL !== undefined) {
      const missing = model === undefined ? '--model' : '--base-url'
      throw new CliRefusal([`${missing} is missing: ${ENDPOINT_FLAGS_REFUSAL}`], 2)
    }
    const add = DASHBOARD_ADD[provider]!
    return { dashboard: pick.kind === 'saved' ? { add, name: pick.name } : { add } }
  }

  const entry: InitModelEntry = { name: name(), provider, model: model ?? defaultModelOf(provider) }
  const url = baseURL ?? target.baseURL
  return { entry: url === undefined ? entry : { ...entry, baseURL: url } }
}

// A compatible key is never pre-selected: it still needs a URL and a model from the dashboard.
export function preselectedModel(saved: readonly SavedCredential[]): InitModelPick {
  return (
    savedPicks(saved).find((pick) => !needsDashboard(pick.provider)) ?? {
      kind: 'new',
      choice: 'claude-code',
    }
  )
}

function isInitModelChoice(value: string): value is InitModelChoice {
  return (INIT_MODEL_CHOICES as readonly string[]).includes(value)
}

export function resolveLlmFlag(value: string, saved: readonly SavedCredential[]): InitModelPick {
  const id = value.trim()
  if (isInitModelChoice(id)) return { kind: 'new', choice: id }
  const savedPick = savedPicks(saved).find((pick) => pick.name === id)
  if (savedPick !== undefined) return savedPick
  throw new CliRefusal(
    [`--llm must be one of ${INIT_MODEL_CHOICES.join(', ')}, or the name of a saved credential`],
    2,
  )
}

export interface InitModelStatus {
  status: 'ready' | 'pending'
  reason?: string
}

const DASHBOARD_REASON = "set up on the dashboard's model page"

// Read from the local store only: the subscription plugin is loaded so the resolver knows its
// provider, and nothing leaves the machine.
export async function modelStatus(input: {
  entry?: InitModelEntry
  dashboard?: InitModelSetup['dashboard']
  configPath: string
  projectDir: string
  authPath: string
  pluginInstalled: boolean
}): Promise<InitModelStatus> {
  const { entry } = input
  if (entry === undefined) return { status: 'pending', reason: DASHBOARD_REASON }
  const subscription = getProvider(entry.provider)?.subscription === true
  if (subscription) {
    if (!input.pluginInstalled) {
      return { status: 'pending', reason: 'the subscription plugin is not installed' }
    }
    try {
      await loadLLMAuthPlugins(
        [{ name: SUBSCRIPTION_AUTH_ENTRY_NAME, package: SUBSCRIPTION_AUTH_PACKAGE }],
        { baseDir: input.projectDir, configPath: input.configPath },
      )
    } catch {
      return { status: 'pending', reason: 'the subscription plugin could not be loaded' }
    }
  }
  const auth = await resolveLLMAuth(entry.name, entry, input.authPath)
  if (auth.kind !== 'missing') return { status: 'ready' }
  return {
    status: 'pending',
    reason: subscription ? 'not signed in' : "add the key on the dashboard's model page",
  }
}
