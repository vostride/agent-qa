// THE CONFIG PAGE'S CLOSED VOCABULARY (429 D-02/D-03/D-04 · PXH-CONF-01).
//
// One pure module owns every tab id, section id and UI state word the Config page, the command
// palette and the product tour share, plus the total map from the 21 live legacy `bucket:item`
// links to the new structure. Each closed set is a union, then a prettier-ignore array pinned
// with satisfies, so the mutation engine can match it line by line. Labels live in config-copy.ts.

import { CONFIG_SECTION_LABELS } from './config-copy'

export type ConfigTab = 'models' | 'targets' | 'execution' | 'project' | 'advanced'
// prettier-ignore
export const CONFIG_TABS = [
  'models',
  'targets',
  'execution',
  'project',
  'advanced',
] as const satisfies readonly ConfigTab[]

export type ConfigSectionId =
  | 'models'
  | 'screenshot-size'
  | 'planner-limits'
  | 'targets'
  | 'devices'
  | 'login-states'
  | 'mobile-app-state'
  | 'browser'
  | 'timeouts'
  | 'runs'
  | 'cache'
  | 'recording'
  | 'accessibility'
  | 'log-capture'
  | 'test-discovery'
  | 'files'
  | 'knowledge'
  | 'dashboard'
  | 'logging'
  | 'pass-rate-scope'
  | 'mcp'
  | 'config-file'
// prettier-ignore
export const CONFIG_SECTION_IDS = [
  'models',
  'screenshot-size',
  'planner-limits',
  'targets',
  'devices',
  'login-states',
  'mobile-app-state',
  'browser',
  'timeouts',
  'runs',
  'cache',
  'recording',
  'accessibility',
  'log-capture',
  'test-discovery',
  'files',
  'knowledge',
  'dashboard',
  'logging',
  'pass-rate-scope',
  'mcp',
  'config-file',
] as const satisfies readonly ConfigSectionId[]

export const CONFIG_SECTIONS = {
  models: ['models', 'screenshot-size', 'planner-limits'],
  targets: ['targets', 'devices', 'login-states', 'mobile-app-state'],
  execution: ['browser', 'timeouts', 'runs', 'cache', 'recording', 'accessibility', 'log-capture'],
  project: ['test-discovery', 'files', 'knowledge', 'dashboard', 'logging', 'pass-rate-scope'],
  advanced: ['mcp', 'config-file'],
} as const satisfies Record<ConfigTab, readonly ConfigSectionId[]>

/** Palette words beside each section label, re-homed from the retired bucket map: no bucket names, no dotted paths. */
export const CONFIG_SECTION_ALIASES = {
  models: ['model', 'llm', 'llms', 'default model', 'default llm', 'providers', 'api key', 'sign in'],
  'screenshot-size': ['vision', 'screenshot', 'resolution'],
  'planner-limits': ['planner', 'sub actions', 'history limit'],
  targets: ['target', 'urls', 'bundle id', 'app package'],
  devices: ['device', 'device profiles'],
  'login-states': ['login state', 'auth state', 'auth states', 'saved auth'],
  'mobile-app-state': ['mobile', 'app state', 'app data', 'reset app data', 'preserve app data'],
  browser: ['viewport', 'headless', 'browser headless', 'engine'],
  timeouts: ['timeout', 'navigation timeout', 'step timeout'],
  runs: ['parallel', 'workers', 'build tag'],
  cache: ['cache dir', 'cache directory'],
  recording: ['record', 'video'],
  accessibility: ['a11y', 'wcag'],
  'log-capture': ['console capture', 'network capture'],
  'test-discovery': ['tests', 'discovery', 'test match', 'suite match', 'ignore patterns'],
  files: ['hooks file', 'env file', 'environment file', 'secrets file'],
  knowledge: ['knowledge dir', 'commit artifacts', 'context budget'],
  dashboard: ['port', 'db path', 'database', 'artifacts', 'artifacts dir', 'runs db'],
  logging: ['log level'],
  'pass-rate-scope': ['pass rate', 'scope', 'attributes', 'flakiness'],
  mcp: ['mcp host', 'mcp port', 'mcp path'],
  'config-file': ['yaml', 'config file path', 'raw config'],
} as const satisfies Record<ConfigSectionId, readonly string[]>

export type LegacyConfigPair =
  | 'workspace:discovery'
  | 'workspace:files'
  | 'knowledge:store'
  | 'services:dashboard'
  | 'services:cache'
  | 'services:auth-states'
  | 'services:logging'
  | 'services:recording'
  | 'services:accessibility'
  | 'services:vision'
  | 'registry:llms'
  | 'registry:targets'
  | 'registry:devices'
  | 'use:browser'
  | 'use:timeouts'
  | 'use:planner'
  | 'use:log-capture'
  | 'use:mobile'
  | 'use:execution-defaults'
  | 'analytics:pass-rate-scope'
// prettier-ignore
export const LEGACY_CONFIG_PAIRS = [
  'workspace:discovery',
  'workspace:files',
  'knowledge:store',
  'services:dashboard',
  'services:cache',
  'services:auth-states',
  'services:logging',
  'services:recording',
  'services:accessibility',
  'services:vision',
  'registry:llms',
  'registry:targets',
  'registry:devices',
  'use:browser',
  'use:timeouts',
  'use:planner',
  'use:log-capture',
  'use:mobile',
  'use:execution-defaults',
  'analytics:pass-rate-scope',
] as const satisfies readonly LegacyConfigPair[]

/** UI-SPEC S1: registry:llms and use:execution-defaults both land on the model list by design. */
export const LEGACY_CONFIG_LINKS = {
  'registry:llms': { tab: 'models', section: 'models' },
  'use:execution-defaults': { tab: 'models', section: 'models' },
  'services:vision': { tab: 'models', section: 'screenshot-size' },
  'use:planner': { tab: 'models', section: 'planner-limits' },
  'registry:targets': { tab: 'targets', section: 'targets' },
  'registry:devices': { tab: 'targets', section: 'devices' },
  'services:auth-states': { tab: 'targets', section: 'login-states' },
  'use:mobile': { tab: 'targets', section: 'mobile-app-state' },
  'use:browser': { tab: 'execution', section: 'browser' },
  'use:timeouts': { tab: 'execution', section: 'timeouts' },
  'services:cache': { tab: 'execution', section: 'cache' },
  'services:recording': { tab: 'execution', section: 'recording' },
  'services:accessibility': { tab: 'execution', section: 'accessibility' },
  'use:log-capture': { tab: 'execution', section: 'log-capture' },
  'workspace:discovery': { tab: 'project', section: 'test-discovery' },
  'workspace:files': { tab: 'project', section: 'files' },
  'knowledge:store': { tab: 'project', section: 'knowledge' },
  'services:dashboard': { tab: 'project', section: 'dashboard' },
  'services:logging': { tab: 'project', section: 'logging' },
  'analytics:pass-rate-scope': { tab: 'project', section: 'pass-rate-scope' },
} as const satisfies Record<LegacyConfigPair, { tab: ConfigTab; section: ConfigSectionId }>

export type SaveState = 'idle' | 'saving' | 'saved' | 'draft' | 'failed' | 'undo'
// prettier-ignore
export const SAVE_STATES = [
  'idle',
  'saving',
  'saved',
  'draft',
  'failed',
  'undo',
] as const satisfies readonly SaveState[]

export type FieldState = 'clean' | 'draft' | 'saving' | 'failed'
// prettier-ignore
export const FIELD_STATES = [
  'clean',
  'draft',
  'saving',
  'failed',
] as const satisfies readonly FieldState[]

export type ConnectionChoice =
  | 'chatgpt-sign-in'
  | 'claude-sign-in'
  | 'openai-compatible-key'
  | 'anthropic-compatible-key'
  | 'gemini-key'
// prettier-ignore
export const CONNECTION_CHOICES = [
  'chatgpt-sign-in',
  'claude-sign-in',
  'openai-compatible-key',
  'anthropic-compatible-key',
  'gemini-key',
] as const satisfies readonly ConnectionChoice[]

export const CONNECTION_CHOICE_PROVIDERS = {
  'chatgpt-sign-in': 'openai-subscription',
  'claude-sign-in': 'anthropic-subscription',
  'openai-compatible-key': 'openai-compatible',
  'anthropic-compatible-key': 'anthropic-compatible',
  'gemini-key': 'gemini',
} as const satisfies Record<ConnectionChoice, string>

export type ModelStatus = 'signed-in' | 'key-saved' | 'not-connected' | 'sign-in-expired'
// prettier-ignore
export const MODEL_STATUSES = [
  'signed-in',
  'key-saved',
  'not-connected',
  'sign-in-expired',
] as const satisfies readonly ModelStatus[]

export type TestResult = 'testing' | 'connected' | 'connected-without-key' | 'failed'
// prettier-ignore
export const TEST_RESULTS = [
  'testing',
  'connected',
  'connected-without-key',
  'failed',
] as const satisfies readonly TestResult[]

export type ExplicitActionKind =
  | 'delete-model'
  | 'delete-target'
  | 'delete-device'
  | 'sign-out'
  | 'remove-key'
  | 'change-knowledge-dir'
  | 'change-db-path'
  | 'change-artifacts-dir'
// prettier-ignore
export const EXPLICIT_ACTION_KINDS = [
  'delete-model',
  'delete-target',
  'delete-device',
  'sign-out',
  'remove-key',
  'change-knowledge-dir',
  'change-db-path',
  'change-artifacts-dir',
] as const satisfies readonly ExplicitActionKind[]

export type LegacyConfigLink =
  | { kind: 'none' }
  | { kind: 'mapped'; tab: ConfigTab; section: ConfigSectionId }
  | { kind: 'unknown' }

export interface ConfigSectionEntry {
  tab: ConfigTab
  section: ConfigSectionId
}

function oneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value)
}

/** Membership against the closed pair list only; anything else is unknown and lands on Models. */
export function resolveLegacyConfigLink(searchParams: URLSearchParams): LegacyConfigLink {
  const bucket = searchParams.get('bucket')
  if (bucket === null) return { kind: 'none' }
  const pair = `${bucket}:${searchParams.get('item') ?? ''}`
  if (!oneOf(LEGACY_CONFIG_PAIRS, pair)) return { kind: 'unknown' }
  const { tab, section } = LEGACY_CONFIG_LINKS[pair]
  return { kind: 'mapped', tab, section }
}

export function resolveConfigTab(param: string | null | undefined): ConfigTab | undefined {
  return oneOf(CONFIG_TABS, param) ? param : undefined
}

export function configTabPath(tab: ConfigTab, section?: ConfigSectionId): string {
  return section ? `/config/${tab}?section=${section}` : `/config/${tab}`
}

const SECTION_ENTRIES: readonly ConfigSectionEntry[] = CONFIG_TABS.flatMap((tab) =>
  CONFIG_SECTIONS[tab].map((section): ConfigSectionEntry => ({ tab, section })),
)

/** A lowercased substring match over each section's label and aliases, in CONFIG_SECTIONS order. */
export function searchConfigSections(query: string): ConfigSectionEntry[] {
  const needle = query.trim().toLowerCase()
  return SECTION_ENTRIES.filter(({ section }) =>
    [CONFIG_SECTION_LABELS[section], ...CONFIG_SECTION_ALIASES[section]].some((haystack) =>
      haystack.toLowerCase().includes(needle),
    ),
  ).map((entry) => ({ ...entry }))
}
