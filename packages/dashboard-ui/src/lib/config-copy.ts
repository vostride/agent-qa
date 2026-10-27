// THE CONFIG PAGE'S STRINGS OF RECORD (429 UI-SPEC Copywriting Contract · PXH-CONF-01..05).
//
// Every sentence the Config page renders is an exported constant or pure function here, so cells
// import the constant instead of re-typing prose. Strings holding an apostrophe use double quotes.
// No string carries storage vocabulary (bucket names, dotted config paths); those stay in
// data-field-path attributes. Connection-failure sentences are never spelled here: they come from
// the shared classifier in @vostride/agent-qa-schema, byte-identical with the CLI (D-18).

import type {
  ConfigSectionId,
  ConfigTab,
  ConnectionChoice,
  ExplicitActionKind,
  ModelStatus,
  SaveState,
  TestResult,
} from './config-tabs'

import type {
  ConfigWriteRefusal,
  LlmSetupRefusal,
} from '@vostride/agent-qa-schema'

import { MARKER_WRITTEN_BACK_SENTENCE, providerErrorSentence } from '@vostride/agent-qa-schema'

export { providerErrorSentence } from '@vostride/agent-qa-schema'

/** An edit in a text field settles this long after the last keystroke, or on blur. */
export const SETTLE_DELAY_MS = 1_000

/** How long "Saved" stays before it fades back to an empty status. */
export const SAVED_VISIBLE_MS = 2_000

/** How long an explicit action offers Undo before it becomes final. */
export const UNDO_WINDOW_MS = 10_000

/** How often the page asks whether the config file changed on disk. */
export const REVISION_POLL_MS = 2_000

/** Between a status word and its action, as in "Couldn't save · Retry". */
export const STATUS_SEPARATOR = ' · '

export const CONFIG_PAGE_TITLE = 'Config'

export const CONFIG_TAB_LABELS = {
  models: 'Models',
  targets: 'Targets',
  execution: 'Execution',
  project: 'Project',
  advanced: 'Advanced',
} as const satisfies Record<ConfigTab, string>

export const CONFIG_TABS_ARIA_LABEL = 'Config sections'
export const TAB_DRAFT_SR_SUFFIX = ", has changes that aren't saved"

export const CONFIG_SECTION_LABELS = {
  models: 'Models',
  'screenshot-size': 'Screenshot size',
  'planner-limits': 'Planner limits',
  targets: 'Targets',
  devices: 'Devices',
  'login-states': 'Saved login states',
  'mobile-app-state': 'Mobile app state',
  browser: 'Browser',
  timeouts: 'Timeouts',
  runs: 'Parallel runs',
  cache: 'Cache',
  recording: 'Recording',
  accessibility: 'Accessibility',
  'log-capture': 'Log capture',
  'test-discovery': 'Test discovery',
  files: 'Hooks, env and secrets files',
  knowledge: 'Knowledge store',
  dashboard: 'Dashboard',
  logging: 'Logging',
  'pass-rate-scope': 'Pass-rate scope',
  mcp: 'MCP access',
  'config-file': 'Config file',
} as const satisfies Record<ConfigSectionId, string>

export function configCommandLabel(tab: ConfigTab, section: ConfigSectionId): string {
  return `Config: ${CONFIG_TAB_LABELS[tab]} / ${CONFIG_SECTION_LABELS[section]}`
}

export const LEGACY_LINK_NOT_FOUND_TEXT = 'That setting link is out of date, so Models is shown instead.'

export const CONFIG_LOAD_FAILED_TITLE = "Couldn't load the config"

export function configLoadFailedBody(reason: string): string {
  return `${reason}. Reload it, or fix the file in your editor — this page picks up the change.`
}

export const RELOAD_CONFIG_LABEL = 'Reload config'

/** The file parses but fails whole-config validation (429-16): one notice above the tabs. */
export const CONFIG_FILE_ISSUES_TITLE = 'The config file has a problem'

export function configFileIssuesBody(reason: string): string {
  return `${reason}. Fix it in your editor — this page picks up the change.`
}

export const SAVE_STATUS_WORDS = {
  saving: 'Saving…',
  saved: 'Saved',
  draft: 'Not saved',
  failed: "Couldn't save",
} as const satisfies Partial<Record<SaveState, string>>

export const RETRY_LABEL = 'Retry'
export const NOT_SAVED_ACTION_NAME = 'Not saved. Go to the first unsaved field.'
export const UNDO_LABEL = 'Undo'
/** A computed write the file changed under twice in a row (429-46); the page has re-read it. */
export const FIELD_CHANGED_TEXT = "This changed in the file. The page now shows the file's value."

/** The past-tense line an explicit action leaves in the status; the status appends " · Undo". */
export function undoLine(kind: ExplicitActionKind, name: string): string {
  switch (kind) {
    case 'delete-model':
      return `Deleted ${name}`
    case 'delete-target':
      return `Deleted target ${name}`
    case 'delete-device':
      return `Deleted device ${name}`
    case 'sign-out':
      return `Signed out of ${name}`
    case 'remove-key':
      return `Removed the key for ${name}`
    case 'change-knowledge-dir':
      return 'Changed the knowledge folder'
    case 'change-db-path':
      return 'Changed the database'
    case 'change-artifacts-dir':
      return 'Changed the artifacts folder'
  }
}

export type DeleteActionKind = Extract<ExplicitActionKind, `delete-${string}`>

/** The accessible name of a row's delete icon button. */
export function deleteActionName(kind: DeleteActionKind, name: string): string {
  switch (kind) {
    case 'delete-model':
      return `Delete model ${name}`
    case 'delete-target':
      return `Delete target ${name}`
    case 'delete-device':
      return `Delete device ${name}`
  }
}

export const ADD_MODEL_LABEL = 'Add model'
export const NEW_MODEL_ROW_TITLE = 'New model'
export const DISCARD_DRAFT_LABEL = 'Discard draft'

export const MODEL_STATUS_WORDS = {
  'signed-in': 'Signed in',
  'key-saved': 'Key saved',
  'not-connected': 'Not connected',
  'sign-in-expired': 'Sign-in expired',
} as const satisfies Record<ModelStatus, string>

export const DEFAULT_BADGE = 'Default'

/** Provider labels for when the provider list can't be read; a row never shows a provider id. */
export const PROVIDER_FALLBACK_LABELS = {
  'openai-compatible': 'OpenAI-compatible',
  'anthropic-compatible': 'Anthropic-compatible',
  gemini: 'Gemini',
  'openai-subscription': 'ChatGPT plan',
  'anthropic-subscription': 'Claude plan',
} as const satisfies Record<string, string>

export function modelLine(model: string, providerLabel: string): string {
  return `${model}${STATUS_SEPARATOR}${providerLabel}`
}

/** The plan a sign-in provider connects through, as the signed-in sentence names it. */
export const SUBSCRIPTION_PLAN_NAMES = {
  'openai-subscription': 'ChatGPT',
  'anthropic-subscription': 'Claude',
} as const satisfies Record<string, string>

export interface ConnectionSentenceOptions {
  /** The model connects by signing in to a plan rather than with a key. */
  signIn: boolean
  /** The endpoint may work without a key (credential-optional providers). */
  keyOptional?: boolean
}

/** One sentence stating a saved model's connection; for a signed-in row the label is the plan's name. */
export function connectionSentence(
  status: ModelStatus,
  providerLabel: string,
  opts: ConnectionSentenceOptions,
): string {
  switch (status) {
    case 'signed-in':
      return `Signed in with your ${providerLabel} plan.`
    case 'key-saved':
      return 'Key saved on this machine.'
    case 'not-connected':
      if (opts.signIn) return 'Not signed in.'
      return opts.keyOptional ? 'No key saved. This endpoint may not need one.' : 'No key saved.'
    case 'sign-in-expired':
      return 'Sign-in expired. Sign in again to use this model.'
  }
}

export const TEST_CONNECTION_LABEL = 'Test connection'
export const MAKE_DEFAULT_LABEL = 'Make default'
export const REPLACE_KEY_LABEL = 'Replace key'
export const REMOVE_KEY_LABEL = 'Remove key'
export const SIGN_IN_AGAIN_LABEL = 'Sign in again'
export const SIGN_OUT_LABEL = 'Sign out'
export const DELETE_MODEL_LABEL = 'Delete model'
export const SAVE_KEY_AND_TEST_LABEL = 'Save key and test'
export const KEEP_CURRENT_KEY_LABEL = 'Keep current key'
export const NEW_KEY_LABEL = 'New key'

/** How a saved model connects, as the fixed-facts line names it; a plugin provider uses its label. */
export const FIXED_CONNECTION_LABELS = {
  'openai-subscription': 'your ChatGPT plan',
  'anthropic-subscription': 'your Claude plan',
  'openai-compatible': 'an OpenAI-compatible API key',
  'anthropic-compatible': 'an Anthropic-compatible key or token',
  gemini: 'a Gemini API key',
} as const satisfies Record<string, string>

export function fixedFactsLine(connectionLabel: string): string {
  return `Connects with ${connectionLabel}. The name and connection are fixed; to change them, add a new model.`
}

/** A saved model's settings in its open row (UI-SPEC S4 item 2); Model and Base URL share the add flow's labels. */
export const MODEL_SETTING_LABELS = {
  vision: 'Vision',
  contextWindow: 'Context window',
} as const satisfies Record<string, string>

export const MODEL_SETTING_HELP = {
  vision: 'Whether this model can read screenshots. Turn it off for text-only models.',
  contextWindow: 'A size such as 256k. Leave it empty to detect it.',
} as const satisfies Record<string, string>

export const HEADER_FIELD_LABELS = {
  name: 'Name',
  value: 'Value',
} as const satisfies Record<string, string>

export const SAVE_HEADER_LABEL = 'Save header'
export const DISCARD_HEADER_LABEL = 'Discard header'
export const HEADER_NAME_REQUIRED_ERROR = 'A header needs a name.'

export function headerNameTakenError(name: string): string {
  return `A header named ${name} already exists.`
}

/** The accessible name of a saved header's name field. */
export function headerNameFieldName(header: string): string {
  return `${HEADER_FIELD_LABELS.name} of the ${header} header`
}

/** A saved header's accessible label, so each name field, eye and Replace value names its header. */
export function modelHeaderLabel(header: string): string {
  return `${header} header`
}

export const DEFAULT_CANNOT_DELETE_LINE = 'This is the default model. Make another model the default first.'
export const NO_MODELS_TEXT = 'Runs need a model. Add one to get started.'
export const NO_DEFAULT_TEXT = 'No default model. Runs need one — make one of these the default.'

/** A failed test shows providerErrorSentence instead, so `failed` has no entry here. */
export const TEST_RESULT_TEXT = {
  testing: 'Testing the connection…',
  connected: 'Connected',
  'connected-without-key': 'Connected without a key',
} as const satisfies Partial<Record<TestResult, string>>

export const CONNECT_LABEL = 'Connect'
export const CONNECTING_LABEL = 'Connecting…'
export const CONNECT_FORM_LEGEND = 'How do you connect?'

export const CONNECTION_CHOICE_LABELS = {
  'chatgpt-sign-in': 'Sign in with ChatGPT',
  'claude-sign-in': 'Sign in with Claude',
  'openai-compatible-key': 'OpenAI-compatible API key',
  'anthropic-compatible-key': 'Anthropic-compatible key or token',
  'gemini-key': 'Gemini API key',
} as const satisfies Record<ConnectionChoice, string>

export const CONNECTION_CHOICE_HINTS = {
  'chatgpt-sign-in': 'Uses your ChatGPT plan. No key needed.',
  'claude-sign-in': 'Uses your Claude plan. No key needed.',
  'openai-compatible-key': 'OpenAI, or any endpoint that speaks its API.',
  'anthropic-compatible-key': 'Anthropic, or any endpoint that speaks its API.',
  'gemini-key': 'A key from Google AI Studio.',
} as const satisfies Record<ConnectionChoice, string>

export const ADD_FLOW_FIELD_LABELS = {
  baseUrl: 'Base URL',
  model: 'Model',
  apiKey: 'API key',
  keyType: 'Key type',
  key: 'Key',
  token: 'Token',
  headers: 'Headers',
  name: 'Name',
  signInCode: 'Code from the sign-in page',
} as const satisfies Record<string, string>

export const ADD_HEADER_LABEL = 'Add header'

export type CredentialKeyType = 'api-key' | 'bearer-token'

export const KEY_TYPE_LABELS = {
  'api-key': 'API key',
  'bearer-token': 'Bearer token',
} as const satisfies Record<CredentialKeyType, string>

export const KEY_OPTIONAL_HELP = "Leave empty if your endpoint doesn't need a key."
export const BASE_URL_HELP = "The exact base URL. agent-qa doesn't add paths to it."

export function existingCredentialLine(kind: 'key' | 'sign-in', name: string): string {
  return kind === 'key'
    ? `A key for ${name} is already saved on this machine.`
    : `Already signed in as ${name} on this machine.`
}

export const NAME_RULE_ERROR = 'Use lowercase letters, digits, hyphens and dots, starting with a letter or digit.'

export function nameTakenError(name: string): string {
  return `A model named ${name} already exists.`
}

export function nameCredentialConflictError(name: string, providerLabel: string): string {
  return `${name} already has a saved sign-in or key for ${providerLabel}. Choose another name.`
}

export const MODEL_REQUIRED_ERROR = 'Model is required.'
export const KEY_REQUIRED_ERROR = 'API key is required.'
export const BASE_URL_REQUIRED_ERROR = 'Base URL is required for compatible providers.'

/** Every code POST /api/llm/connect can refuse with, including the route's own two. */
export type ConnectRefusalCode = LlmSetupRefusal | ConfigWriteRefusal | 'connect_failed' | 'cross_site_refused'

const COULD_NOT_SAVE_MODEL = "Couldn't save the model. Try again."

export const CONNECT_REFUSAL_COPY = {
  invalid_setup_input: 'Check the model and base URL.',
  name_invalid: NAME_RULE_ERROR,
  name_taken: 'Another model already uses this name.',
  credential_provider_conflict: 'This name holds a key for a different connection. Choose another name.',
  credential_not_accepted: "This connection doesn't take that kind of key.",
  credential_missing: KEY_REQUIRED_ERROR,
  credential_exists: 'Another saved key already uses this name.',
  validation_failed: 'The config file has a problem to fix first.',
  file_invalid: "The config file doesn't parse. Fix it in your editor, then connect again.",
  invalid_write_input: COULD_NOT_SAVE_MODEL,
  path_not_found: COULD_NOT_SAVE_MODEL,
  write_failed: COULD_NOT_SAVE_MODEL,
  field_changed: COULD_NOT_SAVE_MODEL,
  path_not_writable: COULD_NOT_SAVE_MODEL,
  marker_written_back: MARKER_WRITTEN_BACK_SENTENCE,
  connect_failed: COULD_NOT_SAVE_MODEL,
  cross_site_refused: "This page isn't allowed to change the config.",
} as const satisfies Record<ConnectRefusalCode, string>

const REFUSALS_WITH_ISSUES: ReadonlySet<string> = new Set<ConnectRefusalCode>(['validation_failed', 'invalid_setup_input'])

function isConnectRefusalCode(code: string): code is ConnectRefusalCode {
  return Object.prototype.hasOwnProperty.call(CONNECT_REFUSAL_COPY, code)
}

/** The network sentence only when the server named no reason this page knows. */
export function connectRefusalSentence(
  code: string | undefined,
  issues?: readonly { message: string }[],
): string {
  if (code === undefined || !isConnectRefusalCode(code)) return providerErrorSentence('network_error', '')
  const sentence: string = CONNECT_REFUSAL_COPY[code]
  const first = issues?.[0]?.message
  if (!REFUSALS_WITH_ISSUES.has(code) || !first) return sentence
  return `${sentence.replace(/\.$/, '')}: ${first}`
}

export const SIGN_IN_WAITING_TEXT = 'Finish signing in on the page that opened.'
export const CANCEL_SIGN_IN_LABEL = 'Cancel sign-in'
export const SIGN_IN_WAITING_LABEL = 'Waiting for sign-in…'
export const SIGN_IN_TIMED_OUT_TEXT = 'Sign-in timed out. Try again.'

export function signInFailedText(reason: string): string {
  return `Sign-in didn't finish: ${reason}`
}

export function connectedSavedText(name: string): string {
  return `Connected. Saved as ${name}.`
}

export const BECAME_DEFAULT_TEXT = "It's now the default model."
/** A sign-in choice whose auth plugin is not registered (research A8); the CLI names the same package. */
export function signInPluginMissingText(choiceLabel: string): string {
  return `${choiceLabel} needs the @vostride/agent-qa-subscription-auth plugin. Install it and list it under plugins.auth in agent-qa.config.yaml.`
}

export const SAVE_WITHOUT_TESTING_LABEL = 'Save without testing'
export const SAVED_WITHOUT_TEST_TEXT = 'Saved without a connection test.'

export const APPLY_LABEL = 'Apply'
export const KEEP_CURRENT_PATH_LABEL = 'Keep current path'

/** The one-word Apply button's accessible name names the path it applies. */
export function applyActionName(pathLabel: string): string {
  return `${APPLY_LABEL} ${pathLabel}`
}

/** Keep current path's accessible name, so each data-path field's button names its own path. */
export function keepPathName(pathLabel: string): string {
  return `${KEEP_CURRENT_PATH_LABEL} for ${pathLabel}`
}

export type DataPathKey = 'knowledge.dir' | 'services.dashboard.dbPath' | 'services.dashboard.artifactsDir'

/**
 * What applying a new data path changes, as the code does it (429-20, law 2): the dashboard opens
 * its database at startup, runs and agent calls resolve the knowledge folder per run or call while
 * a standing daemon keeps the one it started with, and the artifacts folder holds only each run's
 * working-memory file, which nothing the dashboard shows reads.
 */
export const APPLY_CONSEQUENCES = {
  'knowledge.dir':
    'New runs and agents use the new folder right away; a running agent-qa daemon switches when it restarts. Nothing in the current folder is moved or deleted.',
  'services.dashboard.dbPath':
    "The dashboard opens the new database when it restarts, and runs in the current one won't show until you switch back. Nothing is moved or deleted.",
  'services.dashboard.artifactsDir':
    'New runs write their working-memory file to the new folder. Earlier runs still show, and nothing is moved or deleted.',
} as const satisfies Record<DataPathKey, string>

export const PORT_RESTART_HELP = 'Takes effect after the dashboard restarts.'

export const KNOWLEDGE_FIELD_LABELS = {
  dir: 'Knowledge folder',
  commitArtifacts: 'Images committed with knowledge',
  contextBudgetTokens: 'Knowledge budget',
} as const

export const KNOWLEDGE_FIELD_HELP = {
  dir: 'A folder inside this repository.',
  contextBudgetTokens: 'The most tokens of knowledge a run is given. Leave empty for no cap.',
} as const

export const KNOWLEDGE_COMMIT_ARTIFACTS_LABELS = {
  none: 'None',
  thumbnails: 'Thumbnails',
} as const

export const NO_CAP_PLACEHOLDER = 'No cap'

export const DASHBOARD_FIELD_LABELS = {
  port: 'Port',
  host: 'Host',
  dbPath: 'Database file',
  artifactsDir: 'Artifacts folder',
  baseUrl: 'Dashboard address',
  workspace: 'Workspace name',
} as const

export const DASHBOARD_FIELD_HELP = {
  host: "Must be an address on this machine. Takes effect after the dashboard restarts.",
  baseUrl: 'Links to tests and runs in agent answers start with this address. They need a workspace name too.',
  workspace: 'Names this project in those links.',
} as const

export const TEST_DISCOVERY_FIELD_LABELS = {
  testMatch: 'Test files',
  suiteMatch: 'Suite files',
  testPathIgnore: 'Paths to skip',
} as const

export const TEST_DISCOVERY_FIELD_HELP = {
  testMatch: 'One glob pattern per line. A file matching any of them is a test.',
  suiteMatch: 'One glob pattern per line. A file matching any of them is a suite.',
  testPathIgnore: 'One glob pattern per line. Matching files are never picked up as tests.',
} as const

export const TEST_MATCH_REQUIRED_ERROR = 'Add at least one pattern for test files.'
export const SUITE_MATCH_REQUIRED_ERROR = 'Add at least one pattern for suite files.'

export const FILES_FIELD_LABELS = {
  hooksFile: 'Hooks file',
  envFile: 'Environment file',
  secretsFile: 'Secrets file',
} as const

export const FILES_FIELD_HELP = {
  hooksFile: 'The shared hooks module for tests and suites.',
  envFile: 'A dotenv file loaded before runs start.',
  secretsFile:
    'A dotenv-style file for secrets that only running tests read. Its values are shown as [secret:<name>] and never restored; nothing else is masked.',
} as const

export const HOOKS_FILE_REQUIRED_ERROR = 'Hooks file is required.'
export const ENV_FILE_REQUIRED_ERROR = 'Environment file is required.'

export const LOGGING_FIELD_LABELS = {
  level: 'Log level',
} as const

export const LOGGING_FIELD_HELP = {
  level: "How much detail a run prints. A command's own flag wins over it.",
} as const

/** Runs print at Warning when the level is unset. */
export const LOGGING_LEVEL_LABELS = {
  silent: 'Silent',
  error: 'Error',
  warn: 'Warning',
  info: 'Info',
  debug: 'Debug',
} as const

export const PASS_RATE_SCOPE_HELP = 'Scoped pass rates count only runs whose attributes match every one of these.'
export const NO_ATTRIBUTES_TEXT = 'No attributes yet.'
export const ADD_ATTRIBUTE_LABEL = 'Add attribute'
export const MATCH_AS_PATTERN_LABEL = 'Match as a pattern'
/** Beside an attribute's key when its value is matched as a pattern. */
export const ATTRIBUTE_PATTERN_TAG = 'Pattern'
export const INVALID_ATTRIBUTE_PATTERN_ERROR = 'Not a valid pattern.'

export const ATTRIBUTE_FIELD_LABELS = {
  key: 'Attribute',
  value: 'Value',
} as const satisfies Record<string, string>

/** An attribute value's accessible label, so each eye and Replace value names its own attribute. */
export function attributeValueLabel(key: string): string {
  return `${key} value`
}

export function removeAttributeName(key: string): string {
  return `Remove attribute ${key}`
}

export const PRIVACY_FIELD_LABELS = {
  privacy: 'Turn off usage data',
} as const

export const PRIVACY_FIELD_HELP = {
  privacy: 'When on, agent-qa sends no product usage data from this project.',
} as const

/** A duration field's draft error: the forms the field accepts. */
export const DURATION_INPUT_ERROR = 'Use a duration like 30s, 5m or 1h.'

export const BROWSER_FIELD_LABELS = {
  name: 'Browser',
  headless: 'Headless',
  viewportWidth: 'Viewport width',
  viewportHeight: 'Viewport height',
} as const

export const BROWSER_NAME_LABELS = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
} as const

export const HEADLESS_HELP = 'Run web browsers without a visible window.'

export const VISION_FIELD_LABELS = {
  screenshotSize: 'Largest screenshot',
  effectiveResolution: 'Longest edge in pixels',
} as const

export const VISION_FIELD_HELP = {
  screenshotSize: 'The most a screenshot sent to any vision model may weigh, such as 256k. Empty sends it uncompressed.',
  effectiveResolution: 'Screenshots are scaled so their longest edge fits this many pixels.',
} as const

export const PLANNER_FIELD_LABELS = {
  maxActions: 'Most actions per step',
  maxPlanningTurns: 'Most planner calls per step',
  previousStepCount: 'Earlier steps the planner sees',
} as const

export const PLANNER_FIELD_HELP = {
  maxActions: 'Each step may run this many actions; the step stops with the limit reason when it needs one more. Default 30.',
  maxPlanningTurns: 'Each step may make this many planner model calls; the step stops with the limit reason when it needs one more. Default 30.',
  previousStepCount: 'How many earlier steps the planner reads before planning the next.',
} as const

export const TIMEOUT_FIELD_LABELS = {
  step: 'Step timeout',
  test: 'Test timeout',
  navigation: 'Navigation timeout',
} as const

export const TIMEOUT_FIELD_HELP = {
  navigation: 'How long a web page load or URL wait can take. Default 2m. Android and iOS runs do not use it.',
} as const

export const RUNS_FIELD_LABELS = {
  parallel: 'Run tests in parallel',
  workers: 'Parallel workers',
  buildTag: 'Build tag',
} as const

export const RUNS_FIELD_HELP = {
  parallel: 'Run the tests of one run at the same time.',
  workers: 'The most tests that run at once.',
  buildTag: 'Names the app build under test.',
} as const

export const CACHE_FIELD_LABELS = {
  enabled: 'Reuse cached actions',
  dir: 'Cache folder',
} as const

export const RECORDING_FIELD_LABELS = {
  enabled: 'Record video',
  keepFailuresOnly: 'Keep recordings of failed tests only',
} as const

export const RECORDING_FIELD_HELP = {
  enabled: 'Record video of each test. Recordings stay on this machine.',
  keepFailuresOnly: 'Useful for CI and large suites. Passed tests then open on Frames.',
} as const

export const ACCESSIBILITY_FIELD_LABELS = {
  enabled: 'Check accessibility',
  standard: 'Standard',
  runAfter: 'Run checks after',
  failOnViolation: 'Fail tests with violations',
  disableRules: 'Rules to skip',
  exclude: 'Elements to skip',
} as const

export const ACCESSIBILITY_FIELD_HELP = {
  disableRules: 'One axe rule ID per line.',
  exclude: 'One CSS selector per line.',
} as const

export const ACCESSIBILITY_FIELD_PLACEHOLDERS = {
  disableRules: 'color-contrast',
  exclude: '#cookie-banner',
} as const

export const ACCESSIBILITY_STANDARD_LABELS = {
  wcag2a: 'WCAG 2.0 A',
  wcag2aa: 'WCAG 2.0 AA',
  wcag2aaa: 'WCAG 2.0 AAA',
} as const

export const ACCESSIBILITY_ALL_RULES_TEXT = 'All rules'

export const ACCESSIBILITY_RUN_AFTER_LABELS = {
  'every-step': 'Every step',
  navigation: 'Navigation',
  'test-end': 'Test end',
} as const

export const LOG_CAPTURE_FIELD_LABELS = {
  console: 'Capture console logs',
  network: 'Capture network logs',
} as const

export const NO_TARGETS_TEXT = 'No targets yet.'
export const NO_DEVICES_TEXT = 'No devices yet.'
export const NO_LOGIN_STATES_TEXT = 'No saved login states yet. Save one from a web Live Mode session.'
export const LOGIN_STATES_LOADING_TEXT = 'Loading saved login states…'
export const LOGIN_STATES_LOAD_FAILED_TEXT = "Couldn't load saved login states."
export const RELOAD_LOGIN_STATES_LABEL = 'Reload login states'

export const LOGIN_STATE_COLUMN_LABELS = {
  target: 'Target',
  name: 'Name',
  captured: 'Captured',
} as const satisfies Record<string, string>

export const LOGIN_STATES_FIELD_LABELS = {
  dir: 'Login states folder',
} as const

export const LOGIN_STATES_DIR_PLACEHOLDER = '.agent-qa/auth-states'
export const LOGIN_STATES_DIR_REQUIRED_ERROR = 'Add a folder for saved login states.'

export const MOBILE_FIELD_LABELS = {
  appState: 'App state',
} as const

export const MOBILE_APP_STATE_LABELS = {
  preserve: 'Preserve app data',
  reset: 'Reset app data',
} as const satisfies Record<'preserve' | 'reset', string>

export const MOBILE_APP_STATE_HELP = 'Mobile runs need this choice.'

export const ADD_TARGET_LABEL = 'Add target'
export const DISCARD_TARGET_LABEL = 'Discard target'
export const ADD_DEVICE_LABEL = 'Add device'
export const DISCARD_DEVICE_LABEL = 'Discard device'

export const TARGET_PLATFORM_LABELS = {
  web: 'Web',
  android: 'Android',
  ios: 'iOS',
} as const satisfies Record<'web' | 'android' | 'ios', string>

export const TARGET_ENVIRONMENT_LABELS = {
  local: 'Local',
  shared: 'Shared',
  production: 'Production',
} as const satisfies Record<'local' | 'shared' | 'production', string>

// 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW pillar 1): one name for no class, the add row's.
export const TARGET_ENVIRONMENT_PLACEHOLDER = 'Undeclared'

/** The add-target row's environment choices: undeclared first, then the declared classes. */
export const TARGET_ENVIRONMENT_CHOICE_LABELS = {
  undeclared: 'Undeclared',
  ...TARGET_ENVIRONMENT_LABELS,
} as const satisfies Record<'undeclared' | 'local' | 'shared' | 'production', string>

export const TARGET_FIELD_LABELS = {
  name: 'Name',
  platform: 'Platform',
  url: 'URL',
  product: 'Product',
  bundleId: 'Bundle ID',
  appPackage: 'App package',
  appActivity: 'App activity',
  appPath: 'App file',
  environment: 'Environment',
} as const satisfies Record<string, string>

/** Before an app file in a mobile target's summary. */
export const TARGET_APP_SUMMARY_PREFIX = 'App'

export const TARGET_NAME_REQUIRED_ERROR = 'Add a name for the target.'
export const TARGET_NAME_FORMAT_ERROR =
  'Use lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit.'
export const TARGET_URL_REQUIRED_ERROR = 'Add the URL for a web target.'
export const TARGET_WEB_NEEDS_URL_ERROR = 'Add a URL before making this a web target.'
export const TARGET_PRODUCT_ERROR = "A product name can't contain two dots in a row, slashes or backslashes."
export const TARGET_APP_PATH_ERROR = 'Use a path inside the project, not a full path.'

export function targetNameTakenError(name: string): string {
  return `A target named ${name} already exists.`
}

export const DEVICE_FIELD_LABELS = {
  name: 'Name',
  platform: 'Platform',
  key: 'Setting',
  value: 'Value',
} as const satisfies Record<string, string>

export const DEVICE_NAME_REQUIRED_ERROR = 'Add a name for the device.'

export function deviceNameTakenError(name: string): string {
  return `A device named ${name} already exists.`
}

/** Under Add setting on a device: the settings that device can match on. */
export function deviceMatchKeysHelp(platform: string, keys: readonly string[]): string {
  return `An ${platform} device can match on ${keys.join(', ')}.`
}

/** A device setting's accessible label, so each eye and Replace value names its own device and key. */
export function deviceMatchSettingLabel(device: string, key: string): string {
  return `${device} ${key}`
}

export function removeMatchSettingName(device: string, key: string): string {
  return `Remove setting ${key} from ${device}`
}

export const MCP_FIELD_LABELS = {
  enabled: 'MCP server',
  transport: 'Transport',
  host: 'Host',
  port: 'Port',
  path: 'Path',
} as const satisfies Record<string, string>

export const MCP_FIELD_HELP = {
  enabled: "When off, the dashboard doesn't host the MCP endpoint.",
  host: 'Only localhost, 127.0.0.1 or ::1.',
} as const satisfies Record<string, string>

export const MCP_TRANSPORT_LABELS = {
  http: 'HTTP',
  stdio: 'Stdio',
} as const satisfies Record<'http' | 'stdio', string>

export const MCP_TRANSPORT_PLACEHOLDER = 'Not set'
export const MCP_HOST_ERROR = 'Use localhost, 127.0.0.1 or ::1.'
export const MCP_PATH_ERROR = 'Start the path with /.'

// 2026-10-01 (432-22, D-12): the access-token and run-service-token rows, their scope and trust-scope
// labels and their errors are deleted with the token keys. MCP and the run service are tokenless.

export const CONFIG_FILE_NOTE = 'Read-only. Edit the file in your editor; changes show here by themselves.'
export const COPY_PATH_LABEL = 'Copy config file path'

export const COPY_STATUS_WORDS = {
  copied: 'Copied',
  failed: "Couldn't copy",
} as const satisfies Record<'copied' | 'failed', string>

export const REPLACE_VALUE_LABEL = 'Replace value'
export const SAVE_VALUE_LABEL = 'Save value'
export const KEEP_CURRENT_VALUE_LABEL = 'Keep current value'

export function replaceValueName(label: string): string {
  return `${REPLACE_VALUE_LABEL} for ${label}`
}

export function saveValueName(label: string): string {
  return `${SAVE_VALUE_LABEL} for ${label}`
}

export function keepValueName(label: string): string {
  return `${KEEP_CURRENT_VALUE_LABEL} for ${label}`
}

export const SAVE_SETTING_LABEL = 'Save setting'
export const DISCARD_SETTING_LABEL = 'Discard setting'
export const ADD_SETTING_LABEL = 'Add setting'

export const TOUR_LLM_SETUP_BODY =
  "A run needs a model. Add one: choose how you connect, and it's tested and saved as soon as it works."
