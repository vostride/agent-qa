import { NameSlugSchema, type SavedCredential } from '@vostride/agent-qa-core'
import { getProvider } from '@vostride/agent-qa-model'

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
function savedPicks(saved: readonly SavedCredential[]): Array<InitModelPick & { kind: 'saved' }> {
  const picks: Array<InitModelPick & { kind: 'saved' }> = []
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
