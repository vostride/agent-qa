// Config sentences are constants here; connection-failure text comes from the schema classifier.

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
import { t } from '@/lib/i18n'

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

export const CONFIG_PAGE_TITLE = t('Config')

export const CONFIG_TAB_LABELS = {
  get models() {
    return t('Models')
  },
  get targets() {
    return t('Targets')
  },
  get execution() {
    return t('Execution')
  },
  get project() {
    return t('Project')
  },
  get advanced() {
    return t('Advanced')
  },
} as const satisfies Record<ConfigTab, string>

export const CONFIG_TABS_ARIA_LABEL = t('Config sections')
export const TAB_DRAFT_SR_SUFFIX = t(", has changes that aren't saved")

export const CONFIG_SECTION_LABELS = {
  get models() {
    return t('Models')
  },
  get 'screenshot-size'() {
    return t('Screenshot size')
  },
  get 'planner-limits'() {
    return t('Planner limits')
  },
  get targets() {
    return t('Targets')
  },
  get remotes() {
    return t('Remotes')
  },
  get devices() {
    return t('Devices')
  },
  get 'login-states'() {
    return t('Saved login states')
  },
  get 'mobile-app-state'() {
    return t('Mobile app state')
  },
  get browser() {
    return t('Browser')
  },
  get timeouts() {
    return t('Timeouts')
  },
  get runs() {
    return t('Parallel runs')
  },
  get cache() {
    return t('Cache')
  },
  get recording() {
    return t('Recording')
  },
  get accessibility() {
    return t('Accessibility')
  },
  get 'log-capture'() {
    return t('Log capture')
  },
  get 'test-discovery'() {
    return t('Test discovery')
  },
  get files() {
    return t('Hooks, env and secrets files')
  },
  get knowledge() {
    return t('Knowledge store')
  },
  get dashboard() {
    return t('Dashboard')
  },
  get logging() {
    return t('Logging')
  },
  get 'pass-rate-scope'() {
    return t('Pass-rate scope')
  },
  get mcp() {
    return t('MCP access')
  },
  get 'config-file'() {
    return t('Config file')
  },
} as const satisfies Record<ConfigSectionId, string>

export function configCommandLabel(tab: ConfigTab, section: ConfigSectionId): string {
  return `Config: ${CONFIG_TAB_LABELS[tab]} / ${CONFIG_SECTION_LABELS[section]}`
}

export const LEGACY_LINK_NOT_FOUND_TEXT = t('That setting link is out of date, so Models is shown instead.')

export const CONFIG_LOAD_FAILED_TITLE = t("Couldn't load the config")

export function configLoadFailedBody(reason: string): string {
  return `${reason}. Reload it, or fix the file in your editor — this page picks up the change.`
}

export const RELOAD_CONFIG_LABEL = t('Reload config')

/** The file parses but fails whole-config validation: one notice above the tabs. */
export const CONFIG_FILE_ISSUES_TITLE = t('The config file has a problem')

export function configFileIssuesBody(reason: string): string {
  return `${reason}. Fix it in your editor — this page picks up the change.`
}

export const SAVE_STATUS_WORDS = {
  get saving() {
    return t('Saving…')
  },
  get saved() {
    return t('Saved')
  },
  get draft() {
    return t('Not saved')
  },
  get failed() {
    return t("Couldn't save")
  },
} as const satisfies Partial<Record<SaveState, string>>

export const RETRY_LABEL = t('Retry')
export const NOT_SAVED_ACTION_NAME = t('Not saved. Go to the first unsaved field.')
export const UNDO_LABEL = t('Undo')
/** A computed write the file changed under twice in a row; the page has re-read it. */
export const FIELD_CHANGED_TEXT = t("This changed in the file. The page now shows the file's value.")

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
      return t('Changed the knowledge folder')
    case 'change-db-path':
      return t('Changed the database')
    case 'change-artifacts-dir':
      return t('Changed the artifacts folder')
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

export const ADD_MODEL_LABEL = t('Add model')
export const NEW_MODEL_ROW_TITLE = t('New model')
export const DISCARD_DRAFT_LABEL = t('Discard draft')

export const MODEL_STATUS_WORDS = {
  get 'signed-in'() {
    return t('Signed in')
  },
  get 'key-saved'() {
    return t('Key saved')
  },
  get 'not-connected'() {
    return t('Not connected')
  },
  get 'sign-in-expired'() {
    return t('Sign-in expired')
  },
} as const satisfies Record<ModelStatus, string>

export const DEFAULT_BADGE = t('Default')

/** Provider labels for when the provider list can't be read; a row never shows a provider id. */
export const PROVIDER_FALLBACK_LABELS = {
  'openai-compatible': 'OpenAI-compatible',
  'anthropic-compatible': 'Anthropic-compatible',
  gemini: 'Gemini',
  get 'openai-subscription'() {
    return t('ChatGPT plan')
  },
  get 'anthropic-subscription'() {
    return t('Claude plan')
  },
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
      return t('Key saved on this machine.')
    case 'not-connected':
      if (opts.signIn) return t('Not signed in.')
      return opts.keyOptional ? t('No key saved. This endpoint may not need one.') : t('No key saved.')
    case 'sign-in-expired':
      return t('Sign-in expired. Sign in again to use this model.')
  }
}

export const TEST_CONNECTION_LABEL = t('Test connection')
export const MAKE_DEFAULT_LABEL = t('Make default')
export const REPLACE_KEY_LABEL = t('Replace key')
export const REMOVE_KEY_LABEL = t('Remove key')
export const SIGN_IN_AGAIN_LABEL = t('Sign in again')
export const SIGN_OUT_LABEL = t('Sign out')
export const DELETE_MODEL_LABEL = t('Delete model')
export const SAVE_KEY_AND_TEST_LABEL = t('Save key and test')
export const KEEP_CURRENT_KEY_LABEL = t('Keep current key')
export const NEW_KEY_LABEL = t('New key')

/** How a saved model connects, as the fixed-facts line names it; a plugin provider uses its label. */
export const FIXED_CONNECTION_LABELS = {
  get 'openai-subscription'() {
    return t('your ChatGPT plan')
  },
  get 'anthropic-subscription'() {
    return t('your Claude plan')
  },
  get 'openai-compatible'() {
    return t('an OpenAI-compatible API key')
  },
  get 'anthropic-compatible'() {
    return t('an Anthropic-compatible key or token')
  },
  get gemini() {
    return t('a Gemini API key')
  },
} as const satisfies Record<string, string>

export function fixedFactsLine(connectionLabel: string): string {
  return `Connects with ${connectionLabel}. The name and connection are fixed; to change them, add a new model.`
}

/** A saved model's settings in its open row; Model and Base URL share the add flow's labels. */
export const MODEL_SETTING_LABELS = {
  get vision() {
    return t('Vision')
  },
  get contextWindow() {
    return t('Context window')
  },
} as const satisfies Record<string, string>

export const MODEL_SETTING_HELP = {
  get vision() {
    return t('Whether this model can read screenshots. Turn it off for text-only models.')
  },
  get contextWindow() {
    return t('A size such as 256k. Leave it empty to detect it.')
  },
} as const satisfies Record<string, string>

export const HEADER_FIELD_LABELS = {
  get name() {
    return t('Name')
  },
  get value() {
    return t('Value')
  },
} as const satisfies Record<string, string>

export const SAVE_HEADER_LABEL = t('Save header')
export const DISCARD_HEADER_LABEL = t('Discard header')
export const HEADER_NAME_REQUIRED_ERROR = t('A header needs a name.')

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

export const DEFAULT_CANNOT_DELETE_LINE = t('This is the default model. Make another model the default first.')
export const NO_MODELS_TEXT = t('Runs need a model. Add one to get started.')
export const NO_DEFAULT_TEXT = t('No default model. Runs need one — make one of these the default.')

/** A failed test shows providerErrorSentence instead, so `failed` has no entry here. */
export const TEST_RESULT_TEXT = {
  get testing() {
    return t('Testing the connection…')
  },
  get connected() {
    return t('Connected')
  },
  get 'connected-without-key'() {
    return t('Connected without a key')
  },
} as const satisfies Partial<Record<TestResult, string>>

export const CONNECT_LABEL = t('Connect')
export const CONNECTING_LABEL = t('Connecting…')
export const CONNECT_FORM_LEGEND = t('How do you connect?')

export const CONNECTION_CHOICE_LABELS = {
  get 'chatgpt-sign-in'() {
    return t('Sign in with ChatGPT')
  },
  get 'claude-sign-in'() {
    return t('Sign in with Claude')
  },
  get 'openai-compatible-key'() {
    return t('OpenAI-compatible API key')
  },
  get 'anthropic-compatible-key'() {
    return t('Anthropic-compatible key or token')
  },
  get 'gemini-key'() {
    return t('Gemini API key')
  },
} as const satisfies Record<ConnectionChoice, string>

export const CONNECTION_CHOICE_HINTS = {
  get 'chatgpt-sign-in'() {
    return t('Uses your ChatGPT plan. No key needed.')
  },
  get 'claude-sign-in'() {
    return t('Uses your Claude plan. No key needed.')
  },
  get 'openai-compatible-key'() {
    return t('OpenAI, or any endpoint that speaks its API.')
  },
  get 'anthropic-compatible-key'() {
    return t('Anthropic, or any endpoint that speaks its API.')
  },
  get 'gemini-key'() {
    return t('A key from Google AI Studio.')
  },
} as const satisfies Record<ConnectionChoice, string>

export const ADD_FLOW_FIELD_LABELS = {
  get baseUrl() {
    return t('Base URL')
  },
  get model() {
    return t('Model')
  },
  get apiKey() {
    return t('API key')
  },
  get keyType() {
    return t('Key type')
  },
  get key() {
    return t('Key')
  },
  get token() {
    return t('Token')
  },
  get headers() {
    return t('Headers')
  },
  get name() {
    return t('Name')
  },
  get signInCode() {
    return t('Code from the sign-in page')
  },
} as const satisfies Record<string, string>

export const ADD_HEADER_LABEL = t('Add header')

export type CredentialKeyType = 'api-key' | 'bearer-token'

export const KEY_TYPE_LABELS = {
  get 'api-key'() {
    return t('API key')
  },
  get 'bearer-token'() {
    return t('Bearer token')
  },
} as const satisfies Record<CredentialKeyType, string>

export const KEY_OPTIONAL_HELP = t("Leave empty if your endpoint doesn't need a key.")
export const BASE_URL_HELP = t("The exact base URL. agent-qa doesn't add paths to it.")

export function existingCredentialLine(kind: 'key' | 'sign-in', name: string): string {
  return kind === 'key'
    ? `A key for ${name} is already saved on this machine.`
    : `Already signed in as ${name} on this machine.`
}

export const NAME_RULE_ERROR = t('Use lowercase letters, digits, hyphens and dots, starting with a letter or digit.')

export function nameTakenError(name: string): string {
  return `A model named ${name} already exists.`
}

export function nameCredentialConflictError(name: string, providerLabel: string): string {
  return `${name} already has a saved sign-in or key for ${providerLabel}. Choose another name.`
}

export const MODEL_REQUIRED_ERROR = t('Model is required.')
export const KEY_REQUIRED_ERROR = t('API key is required.')
export const BASE_URL_REQUIRED_ERROR = t('Base URL is required for compatible providers.')

/** Every code POST /api/llm/connect can refuse with, including the route's own two. */
export type ConnectRefusalCode = LlmSetupRefusal | ConfigWriteRefusal | 'connect_failed' | 'cross_site_refused'

const COULD_NOT_SAVE_MODEL = t("Couldn't save the model. Try again.")

export const CONNECT_REFUSAL_COPY = {
  get invalid_setup_input() {
    return t('Check the model and base URL.')
  },
  name_invalid: NAME_RULE_ERROR,
  get name_taken() {
    return t('Another model already uses this name.')
  },
  get credential_provider_conflict() {
    return t('This name holds a key for a different connection. Choose another name.')
  },
  get credential_not_accepted() {
    return t("This connection doesn't take that kind of key.")
  },
  credential_missing: KEY_REQUIRED_ERROR,
  get credential_exists() {
    return t('Another saved key already uses this name.')
  },
  get validation_failed() {
    return t('The config file has a problem to fix first.')
  },
  get file_invalid() {
    return t("The config file doesn't parse. Fix it in your editor, then connect again.")
  },
  invalid_write_input: COULD_NOT_SAVE_MODEL,
  path_not_found: COULD_NOT_SAVE_MODEL,
  write_failed: COULD_NOT_SAVE_MODEL,
  field_changed: COULD_NOT_SAVE_MODEL,
  path_not_writable: COULD_NOT_SAVE_MODEL,
  marker_written_back: MARKER_WRITTEN_BACK_SENTENCE,
  connect_failed: COULD_NOT_SAVE_MODEL,
  get cross_site_refused() {
    return t("This page isn't allowed to change the config.")
  },
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

export const SIGN_IN_WAITING_TEXT = t('Finish signing in on the page that opened.')
export const CANCEL_SIGN_IN_LABEL = t('Cancel sign-in')
export const SIGN_IN_WAITING_LABEL = t('Waiting for sign-in…')
export const SIGN_IN_TIMED_OUT_TEXT = t('Sign-in timed out. Try again.')

export function signInFailedText(reason: string): string {
  return `Sign-in didn't finish: ${reason}`
}

export function connectedSavedText(name: string): string {
  return `Connected. Saved as ${name}.`
}

export const BECAME_DEFAULT_TEXT = t("It's now the default model.")
/** A sign-in choice whose auth plugin is not registered; the CLI names the same package. */
export function signInPluginMissingText(choiceLabel: string): string {
  return `${choiceLabel} needs the @vostride/agent-qa-subscription-auth plugin. Install it and add it to plugins as name: subscription in agent-qa.config.yaml.`
}

export const SAVE_WITHOUT_TESTING_LABEL = t('Save without testing')
export const SAVED_WITHOUT_TEST_TEXT = t('Saved without a connection test.')

export const APPLY_LABEL = t('Apply')
export const KEEP_CURRENT_PATH_LABEL = t('Keep current path')

/** The one-word Apply button's accessible name names the path it applies. */
export function applyActionName(pathLabel: string): string {
  return `${APPLY_LABEL} ${pathLabel}`
}

/** Keep current path's accessible name, so each data-path field's button names its own path. */
export function keepPathName(pathLabel: string): string {
  return `${KEEP_CURRENT_PATH_LABEL} for ${pathLabel}`
}

export type DataPathKey = 'knowledge.dir' | 'services.dashboard.dbPath' | 'services.dashboard.artifactsDir'

// What applying a new data path changes, as the code does it.
export const APPLY_CONSEQUENCES = {
  get 'knowledge.dir'() {
    return t('New runs and agents use the new folder right away; a running agent-qa daemon switches when it restarts. Nothing in the current folder is moved or deleted.')
  },
  get 'services.dashboard.dbPath'() {
    return t("The dashboard opens the new database when it restarts, and runs in the current one won't show until you switch back. Nothing is moved or deleted.")
  },
  get 'services.dashboard.artifactsDir'() {
    return t('New runs write their working-memory file to the new folder. Earlier runs still show, and nothing is moved or deleted.')
  },
} as const satisfies Record<DataPathKey, string>

export const PORT_RESTART_HELP = t('Takes effect after the dashboard restarts.')

export const KNOWLEDGE_FIELD_LABELS = {
  get dir() {
    return t('Knowledge folder')
  },
} as const

export const KNOWLEDGE_FIELD_HELP = {
  get dir() {
    return t('A folder inside this repository.')
  },
} as const

export const DASHBOARD_FIELD_LABELS = {
  get port() {
    return t('Port')
  },
  get host() {
    return t('Host')
  },
  get dbPath() {
    return t('Database file')
  },
  get artifactsDir() {
    return t('Artifacts folder')
  },
  get baseUrl() {
    return t('Dashboard address')
  },
  get workspace() {
    return t('Workspace name')
  },
} as const

export const DASHBOARD_FIELD_HELP = {
  get host() {
    return t('Must be an address on this machine. Takes effect after the dashboard restarts.')
  },
  get baseUrl() {
    return t('Links to tests and runs in agent answers start with this address. They need a workspace name too.')
  },
  get workspace() {
    return t('Names this project in those links.')
  },
} as const

export const TEST_DISCOVERY_FIELD_LABELS = {
  get testMatch() {
    return t('Test files')
  },
  get suiteMatch() {
    return t('Suite files')
  },
  get testPathIgnore() {
    return t('Paths to skip')
  },
} as const

export const TEST_DISCOVERY_FIELD_HELP = {
  get testMatch() {
    return t('One glob pattern per line. A file matching any of them is a test.')
  },
  get suiteMatch() {
    return t('One glob pattern per line. A file matching any of them is a suite.')
  },
  get testPathIgnore() {
    return t('One glob pattern per line. Matching files are never picked up as tests.')
  },
} as const

export const TEST_MATCH_REQUIRED_ERROR = t('Add at least one pattern for test files.')
export const SUITE_MATCH_REQUIRED_ERROR = t('Add at least one pattern for suite files.')

export const FILES_FIELD_LABELS = {
  get hooksFile() {
    return t('Hooks file')
  },
  get envFile() {
    return t('Environment file')
  },
  get secretsFile() {
    return t('Secrets file')
  },
} as const

export const FILES_FIELD_HELP = {
  get hooksFile() {
    return t('The shared hooks module for tests and suites.')
  },
  get envFile() {
    return t('A dotenv file loaded before runs start.')
  },
  get secretsFile() {
    return t('A dotenv-style file for secrets that only running tests read. Its values are shown as [secret:<name>] and never restored; nothing else is masked.')
  },
} as const

export const HOOKS_FILE_REQUIRED_ERROR = t('Hooks file is required.')
export const ENV_FILE_REQUIRED_ERROR = t('Environment file is required.')

export const LOGGING_FIELD_LABELS = {
  get level() {
    return t('Log level')
  },
} as const

export const LOGGING_FIELD_HELP = {
  get level() {
    return t("How much detail a run prints. A command's own flag wins over it.")
  },
} as const

/** Runs print at Warning when the level is unset. */
export const LOGGING_LEVEL_LABELS = {
  silent: 'Silent',
  error: 'Error',
  warn: 'Warning',
  info: 'Info',
  debug: 'Debug',
} as const

export const PASS_RATE_SCOPE_HELP = t('Scoped pass rates count only runs whose attributes match every one of these.')
export const NO_ATTRIBUTES_TEXT = t('No attributes yet.')
export const ADD_ATTRIBUTE_LABEL = t('Add attribute')
export const MATCH_AS_PATTERN_LABEL = t('Match as a pattern')
/** Beside an attribute's key when its value is matched as a pattern. */
export const ATTRIBUTE_PATTERN_TAG = t('Pattern')
export const INVALID_ATTRIBUTE_PATTERN_ERROR = t('Not a valid pattern.')

export const ATTRIBUTE_FIELD_LABELS = {
  get key() {
    return t('Attribute')
  },
  get value() {
    return t('Value')
  },
} as const satisfies Record<string, string>

/** An attribute value's accessible label, so each eye and Replace value names its own attribute. */
export function attributeValueLabel(key: string): string {
  return `${key} value`
}

export function removeAttributeName(key: string): string {
  return `Remove attribute ${key}`
}

export const PRIVACY_FIELD_LABELS = {
  get privacy() {
    return t('Turn off usage data and error reports')
  },
} as const

export const PRIVACY_FIELD_HELP = {
  get privacy() {
    return t('When on, agent-qa sends no usage data and no error reports from this project. Error reports carry the same anonymous id and properties as usage data.')
  },
} as const

/** A duration field's draft error: the forms the field accepts. */
export const DURATION_INPUT_ERROR = t('Use a duration like 30s, 5m or 1h.')

export const BROWSER_FIELD_LABELS = {
  get name() {
    return t('Browser')
  },
  get headless() {
    return t('Headless')
  },
  get viewportWidth() {
    return t('Viewport width')
  },
  get viewportHeight() {
    return t('Viewport height')
  },
} as const

export const BROWSER_NAME_LABELS = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
} as const

export const HEADLESS_HELP = t('Run web browsers without a visible window.')

export const VISION_FIELD_LABELS = {
  get screenshotSize() {
    return t('Largest screenshot')
  },
  get effectiveResolution() {
    return t('Longest edge in pixels')
  },
} as const

export const VISION_FIELD_HELP = {
  get screenshotSize() {
    return t('The most a screenshot sent to any vision model may weigh, such as 256k. Empty sends it uncompressed.')
  },
  get effectiveResolution() {
    return t('Screenshots are scaled so their longest edge fits this many pixels.')
  },
} as const

export const PLANNER_FIELD_LABELS = {
  get maxActions() {
    return t('Most actions per step')
  },
  get maxPlanningTurns() {
    return t('Most planner calls per step')
  },
  get previousStepCount() {
    return t('Earlier steps the planner sees')
  },
} as const

export const PLANNER_FIELD_HELP = {
  get maxActions() {
    return t('Each step may run this many actions; the step stops with the limit reason when it needs one more. Default 30.')
  },
  get maxPlanningTurns() {
    return t('Each step may make this many planner model calls; the step stops with the limit reason when it needs one more. Default 30.')
  },
  get previousStepCount() {
    return t('How many earlier steps the planner reads before planning the next.')
  },
} as const

export const TIMEOUT_FIELD_LABELS = {
  get step() {
    return t('Step timeout')
  },
  get test() {
    return t('Test timeout')
  },
  get navigation() {
    return t('Navigation timeout')
  },
} as const

export const TIMEOUT_FIELD_HELP = {
  get navigation() {
    return t('How long a web page load or URL wait can take. Default 2m. Android and iOS runs do not use it.')
  },
} as const

export const RUNS_FIELD_LABELS = {
  get parallel() {
    return t('Run tests in parallel')
  },
  get workers() {
    return t('Parallel workers')
  },
  get buildTag() {
    return t('Build tag')
  },
} as const

export const RUNS_FIELD_HELP = {
  get parallel() {
    return t('Run the tests of one run at the same time.')
  },
  get workers() {
    return t('The most tests that run at once.')
  },
  get buildTag() {
    return t('Names the app build under test.')
  },
} as const

export const CACHE_FIELD_LABELS = {
  get enabled() {
    return t('Reuse cached actions')
  },
  get dir() {
    return t('Cache folder')
  },
} as const

export const RECORDING_FIELD_LABELS = {
  get enabled() {
    return t('Record video')
  },
  get keepFailuresOnly() {
    return t('Keep recordings of failed tests only')
  },
} as const

export const RECORDING_FIELD_HELP = {
  get enabled() {
    return t('Record video of each test. Recordings stay on this machine.')
  },
  get keepFailuresOnly() {
    return t('Useful for CI and large suites. Passed tests then open on Frames.')
  },
} as const

export const ACCESSIBILITY_FIELD_LABELS = {
  get enabled() {
    return t('Check accessibility')
  },
  get standard() {
    return t('Standard')
  },
  get runAfter() {
    return t('Run checks after')
  },
  get failOnViolation() {
    return t('Fail tests with violations')
  },
  get disableRules() {
    return t('Rules to skip')
  },
  get exclude() {
    return t('Elements to skip')
  },
} as const

export const ACCESSIBILITY_FIELD_HELP = {
  get disableRules() {
    return t('One axe rule ID per line.')
  },
  get exclude() {
    return t('One CSS selector per line.')
  },
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

export const ACCESSIBILITY_ALL_RULES_TEXT = t('All rules')

export const ACCESSIBILITY_RUN_AFTER_LABELS = {
  get 'every-step'() {
    return t('Every step')
  },
  get 'test-end'() {
    return t('Test end')
  },
} as const

export const LOG_CAPTURE_FIELD_LABELS = {
  get console() {
    return t('Capture console logs')
  },
  get network() {
    return t('Capture network logs')
  },
} as const

export const NO_TARGETS_TEXT = t('No targets yet.')

export const REMOTES_COPY = {
  get defaultLabel() {
    return t('Default for web tests')
  },
  get inherit() {
    return t('Tests and suites inherit this default from agent-qa.config.yaml and can override it in their settings.')
  },
  get thisMachine() {
    return t('This machine')
  },
  get runsOnLabel() {
    return t('Runs on')
  },
  get suiteWinsHint() {
    return t("When a suite picks where it runs, the suite's choice wins.")
  },
  // A url remote's protocol or a plugin remote's plugins entry, and its origin or plugin source.
  columns: { get name() {
    return t('Name')
  }, get kind() {
    return t('Kind')
  }, get origin() {
    return t('Origin')
  } },
  missingValue: '—',
  get pluginNotDeclared() {
    return t('not declared under plugins')
  },
  get empty() {
    return t('No remotes are listed. Add one under registry.remotes in agent-qa.config.yaml:')
  },
  example: [
    'registry:',
    '  remotes:',
    '    - name: grid',
    '      protocol: playwright # or cdp',
    '      url: wss://grid.example.com/playwright',
    '      query: # or headers, with the same {{secret:NAME}} values',
    '        token: "{{secret:GRID_TOKEN}}"',
  ].join('\n'),
  get pick() {
    return t('Pick one with use.browser.remote: <name> in agent-qa.config.yaml, a suite or a test. Use local to run on this machine.')
  },
  get listed() {
    return t('Remotes are defined under registry.remotes in agent-qa.config.yaml and picked with use.browser.remote.')
  },
  get pluginsTitle() {
    return t('Plugins')
  },
  pluginColumns: { get name() {
    return t('Name')
  }, get source() {
    return t('Package or path')
  } },
  get pluginsListed() {
    return t('Plugins are declared under plugins in agent-qa.config.yaml; their options stay in the file.')
  },
} as const

export function pluginRemoteText(entry: string): string {
  return `plugin ${entry}`
}

// The strict parse refuses this default, but the page still shows a config that fails to parse.
export function remoteNotListedParts<T>(name: T): [T, string] {
  return [
    name,
    t(' is not listed under registry.remotes, so web tests that use this default cannot run. List it, or change use.browser.remote.'),
  ]
}

export function remoteUnlistedChoiceParts<T>(name: T): [T, string] {
  return [name, t(' (not listed)')]
}

export function remotePickNotListedParts<T>(name: T): [T, string] {
  return [name, t(" is not listed under the config's remotes.")]
}

export function remoteChoiceParts<T>(name: T, protocol: string | undefined): [T, string] {
  return [name, protocol === undefined ? '' : ` (${protocol})`]
}

export function remoteCredentialsLine(secretsFile: string | undefined): string {
  const file = secretsFile ?? t('your secrets file (set workspace.secretsFile)')
  return `Write credentials as {{secret:NAME}} references to names declared in ${file}.`
}
export const NO_DEVICES_TEXT = t('No devices yet.')
export const NO_LOGIN_STATES_TEXT = t('No saved login states yet. Save one from a web Live Mode session.')
export const LOGIN_STATES_LOADING_TEXT = t('Loading saved login states…')
export const LOGIN_STATES_LOAD_FAILED_TEXT = t("Couldn't load saved login states.")
export const RELOAD_LOGIN_STATES_LABEL = t('Reload login states')

export const LOGIN_STATE_COLUMN_LABELS = {
  get target() {
    return t('Target')
  },
  get name() {
    return t('Name')
  },
  get captured() {
    return t('Captured')
  },
} as const satisfies Record<string, string>

export const LOGIN_STATES_FIELD_LABELS = {
  get dir() {
    return t('Login states folder')
  },
} as const

export const LOGIN_STATES_DIR_PLACEHOLDER = '.agent-qa/auth-states'
export const LOGIN_STATES_DIR_REQUIRED_ERROR = t('Add a folder for saved login states.')

export const MOBILE_FIELD_LABELS = {
  get appState() {
    return t('App state')
  },
} as const

export const MOBILE_APP_STATE_LABELS = {
  get preserve() {
    return t('Preserve app data')
  },
  get reset() {
    return t('Reset app data')
  },
} as const satisfies Record<'preserve' | 'reset', string>

export const MOBILE_APP_STATE_HELP = t('Mobile runs need this choice.')

export const ADD_TARGET_LABEL = t('Add target')
export const DISCARD_TARGET_LABEL = t('Discard target')
export const ADD_DEVICE_LABEL = t('Add device')
export const DISCARD_DEVICE_LABEL = t('Discard device')

export const TARGET_PLATFORM_LABELS = {
  get web() {
    return t('Web')
  },
  get android() {
    return t('Android')
  },
  get ios() {
    return t('iOS')
  },
} as const satisfies Record<'web' | 'android' | 'ios', string>

export const TARGET_ENVIRONMENT_LABELS = {
  get local() {
    return t('Local')
  },
  get shared() {
    return t('Shared')
  },
  get production() {
    return t('Production')
  },
} as const satisfies Record<'local' | 'shared' | 'production', string>

export const TARGET_ENVIRONMENT_PLACEHOLDER = t('Undeclared')

/** The add-target row's environment choices: undeclared first, then the declared classes. */
export const TARGET_ENVIRONMENT_CHOICE_LABELS = {
  get undeclared() {
    return t('Undeclared')
  },
  ...TARGET_ENVIRONMENT_LABELS,
} as const satisfies Record<'undeclared' | 'local' | 'shared' | 'production', string>

export const TARGET_FIELD_LABELS = {
  get name() {
    return t('Name')
  },
  get platform() {
    return t('Platform')
  },
  get url() {
    return t('URL')
  },
  get product() {
    return t('Product')
  },
  bundleId: 'Bundle ID',
  get appPackage() {
    return t('App package')
  },
  get appActivity() {
    return t('App activity')
  },
  get appPath() {
    return t('App file')
  },
  get appRef() {
    return t('App reference')
  },
  get device() {
    return t('Default device')
  },
  get environment() {
    return t('Environment')
  },
} as const satisfies Record<string, string>

export const TARGET_DEVICE_NONE = t('None')
export const TARGET_DEVICE_HELP =
  t('Tests on this target run on this device unless a suite or test picks another.')
export const TARGET_APP_REF_NOTE =
  t('The app a remote device installs. Set it in agent-qa.config.yaml; this page shows it read-only.')

/** A target's device that no device of the target's platform matches, kept in its select. */
export function targetDeviceUnlistedChoice(name: string): string {
  return `${name} (not listed for this platform)`
}

/** Before an app file in a mobile target's summary. */
export const TARGET_APP_SUMMARY_PREFIX = t('App')

export const TARGET_NAME_REQUIRED_ERROR = t('Add a name for the target.')
export const TARGET_NAME_FORMAT_ERROR =
  t('Use lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit.')
export const TARGET_URL_REQUIRED_ERROR = t('Add the URL for a web target.')
export const TARGET_WEB_NEEDS_URL_ERROR = t('Add a URL before making this a web target.')
export const TARGET_PRODUCT_ERROR = t("A product name can't contain two dots in a row, slashes or backslashes.")
export const TARGET_APP_PATH_ERROR = t('Use a path inside the project, not a full path.')

export function targetNameTakenError(name: string): string {
  return `A target named ${name} already exists.`
}

export const DEVICE_FIELD_LABELS = {
  get name() {
    return t('Name')
  },
  get platform() {
    return t('Platform')
  },
  get model() {
    return t('Model')
  },
  get os() {
    return t('OS version')
  },
  get id() {
    return t('Device ID')
  },
  get capabilities() {
    return t('Capabilities')
  },
} as const satisfies Record<string, string>

export const DEVICE_NAME_REQUIRED_ERROR = t('Add a name for the device.')

export function deviceNameTakenError(name: string): string {
  return `A device named ${name} already exists.`
}

export const DEVICE_ID_HELP =
  t('Needed only when two identical devices are attached at once: an Android serial or an iOS simulator udid.')
export const DEVICE_CAPABILITIES_NOTE =
  t('Set capabilities in agent-qa.config.yaml; this page shows them read-only.')

/** A capability's accessible label, so each value names its own device and key. */
export function deviceCapabilityLabel(device: string, key: string): string {
  return `${device} capability ${key}`
}

/** A device's remote, shown read-only: pointing a device at a server is a file edit. */
export function deviceRemoteText(remote: string): string {
  return `Runs on remote ${remote}`
}

export const MCP_FIELD_LABELS = {
  get enabled() {
    return t('MCP server')
  },
  get port() {
    return t('Port')
  },
} as const satisfies Record<string, string>

export const MCP_FIELD_HELP = {
  get enabled() {
    return t("When off, the dashboard doesn't host the MCP endpoint.")
  },
} as const satisfies Record<string, string>

// MCP and the run service are tokenless, so this copy has no token rows.

export const CONFIG_FILE_NOTE = t('Read-only. Edit the file in your editor; changes show here by themselves.')
export const COPY_PATH_LABEL = t('Copy config file path')

export const COPY_STATUS_WORDS = {
  get copied() {
    return t('Copied')
  },
  get failed() {
    return t("Couldn't copy")
  },
} as const satisfies Record<'copied' | 'failed', string>

export const REPLACE_VALUE_LABEL = t('Replace value')
export const SAVE_VALUE_LABEL = t('Save value')
export const KEEP_CURRENT_VALUE_LABEL = t('Keep current value')

export function replaceValueName(label: string): string {
  return `${REPLACE_VALUE_LABEL} for ${label}`
}

export function saveValueName(label: string): string {
  return `${SAVE_VALUE_LABEL} for ${label}`
}

export function keepValueName(label: string): string {
  return `${KEEP_CURRENT_VALUE_LABEL} for ${label}`
}

export const SAVE_SETTING_LABEL = t('Save setting')
export const DISCARD_SETTING_LABEL = t('Discard setting')

export const TOUR_LLM_SETUP_BODY =
  t("A run needs a model. Add one: choose how you connect, and it's tested and saved as soon as it works.")
