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

import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'

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

export const CONFIG_TAB_LABELS = textTable({
  models: () => t('config.tabs.models'),
  targets: () => t('config.tabs.targets'),
  execution: () => t('config.tabs.execution'),
  project: () => t('config.tabs.project'),
  advanced: () => t('config.tabs.advanced'),
}) satisfies Record<ConfigTab, string>

export const CONFIG_TABS_ARIA_LABEL = 'Config sections'
export const TAB_DRAFT_SR_SUFFIX = ", has changes that aren't saved"

export const CONFIG_SECTION_LABELS = textTable({
  models: () => t('config.sections.models'),
  'screenshot-size': () => t('config.sections.screenshotSize'),
  'planner-limits': () => t('config.sections.plannerLimits'),
  targets: () => t('config.sections.targets'),
  remotes: () => t('config.sections.remotes'),
  devices: () => t('config.sections.devices'),
  'login-states': () => t('config.sections.loginStates'),
  'mobile-app-state': () => t('config.sections.mobileAppState'),
  browser: () => t('config.sections.browser'),
  timeouts: () => t('config.sections.timeouts'),
  runs: () => t('config.sections.runs'),
  cache: () => t('config.sections.cache'),
  recording: () => t('config.sections.recording'),
  accessibility: () => t('config.sections.accessibility'),
  'log-capture': () => t('config.sections.logCapture'),
  'test-discovery': () => t('config.sections.testDiscovery'),
  files: () => t('config.sections.files'),
  knowledge: () => t('config.sections.knowledge'),
  dashboard: () => t('config.sections.dashboard'),
  logging: () => t('config.sections.logging'),
  'pass-rate-scope': () => t('config.sections.passRateScope'),
  mcp: () => t('config.sections.mcp'),
  'config-file': () => t('config.sections.configFile'),
}) satisfies Record<ConfigSectionId, string>

export function configCommandLabel(tab: ConfigTab, section: ConfigSectionId): string {
  return t('config.commandLabel', {
    tab: CONFIG_TAB_LABELS[tab],
    section: CONFIG_SECTION_LABELS[section],
  })
}

export const LEGACY_LINK_NOT_FOUND_TEXT = 'That setting link is out of date, so Models is shown instead.'

export const CONFIG_LOAD_FAILED_TITLE = "Couldn't load the config"

export function configLoadFailedBody(reason: string): string {
  return t('config.loadFailedBody', { reason })
}

export const RELOAD_CONFIG_LABEL = 'Reload config'

/** The file parses but fails whole-config validation: one notice above the tabs. */
export const CONFIG_FILE_ISSUES_TITLE = 'The config file has a problem'

export function configFileIssuesBody(reason: string): string {
  return t('config.fileIssuesBody', { reason })
}

export const SAVE_STATUS_WORDS = textTable({
  saving: () => t('config.saveStatus.saving'),
  saved: () => t('config.saveStatus.saved'),
  draft: () => t('config.saveStatus.draft'),
  failed: () => t('config.saveStatus.failed'),
}) satisfies Partial<Record<SaveState, string>>

export const RETRY_LABEL = 'Retry'
export const NOT_SAVED_ACTION_NAME = 'Not saved. Go to the first unsaved field.'
export const UNDO_LABEL = 'Undo'
/** A computed write the file changed under twice in a row; the page has re-read it. */
export const FIELD_CHANGED_TEXT = "This changed in the file. The page now shows the file's value."

/** The past-tense line an explicit action leaves in the status; the status appends " · Undo". */
export function undoLine(kind: ExplicitActionKind, name: string): string {
  switch (kind) {
    case 'delete-model':
      return t('config.undo.deleteModel', { name })
    case 'delete-target':
      return t('config.undo.deleteTarget', { name })
    case 'delete-device':
      return t('config.undo.deleteDevice', { name })
    case 'sign-out':
      return t('config.undo.signOut', { name })
    case 'remove-key':
      return t('config.undo.removeKey', { name })
    case 'change-knowledge-dir':
      return t('config.undo.changeKnowledgeDir')
    case 'change-db-path':
      return t('config.undo.changeDbPath')
    case 'change-artifacts-dir':
      return t('config.undo.changeArtifactsDir')
  }
}

export type DeleteActionKind = Extract<ExplicitActionKind, `delete-${string}`>

/** The accessible name of a row's delete icon button. */
export function deleteActionName(kind: DeleteActionKind, name: string): string {
  switch (kind) {
    case 'delete-model':
      return t('config.deleteAction.model', { name })
    case 'delete-target':
      return t('config.deleteAction.target', { name })
    case 'delete-device':
      return t('config.deleteAction.device', { name })
  }
}

export const ADD_MODEL_LABEL = 'Add model'
export const NEW_MODEL_ROW_TITLE = 'New model'
export const DISCARD_DRAFT_LABEL = 'Discard draft'

export const MODEL_STATUS_WORDS = textTable({
  'signed-in': () => t('config.modelStatus.signedIn'),
  'key-saved': () => t('config.modelStatus.keySaved'),
  'not-connected': () => t('config.modelStatus.notConnected'),
  'sign-in-expired': () => t('config.modelStatus.signInExpired'),
}) satisfies Record<ModelStatus, string>

export const DEFAULT_BADGE = 'Default'

/** Provider labels for when the provider list can't be read; a row never shows a provider id. */
export const PROVIDER_FALLBACK_LABELS = textTable({
  'openai-compatible': () => t('config.providerFallback.openaiCompatible'),
  'anthropic-compatible': () => t('config.providerFallback.anthropicCompatible'),
  gemini: () => 'Gemini',
  'openai-subscription': () => t('config.providerFallback.openaiSubscription'),
  'anthropic-subscription': () => t('config.providerFallback.anthropicSubscription'),
}) satisfies Record<string, string>

export function modelLine(model: string, providerLabel: string): string {
  return `${model}${STATUS_SEPARATOR}${providerLabel}`
}

/** The plan a sign-in provider connects through, as the signed-in sentence names it. */
export const SUBSCRIPTION_PLAN_NAMES = textTable({
  'openai-subscription': () => 'ChatGPT',
  'anthropic-subscription': () => 'Claude',
}) satisfies Record<string, string>

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
      return t('config.connection.signedIn', { provider: providerLabel })
    case 'key-saved':
      return t('config.connection.keySaved')
    case 'not-connected':
      if (opts.signIn) return t('config.connection.notSignedIn')
      return opts.keyOptional
        ? t('config.connection.noKeyOptional')
        : t('config.connection.noKey')
    case 'sign-in-expired':
      return t('config.connection.signInExpired')
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
export const FIXED_CONNECTION_LABELS = textTable({
  'openai-subscription': () => t('config.fixedConnection.openaiSubscription'),
  'anthropic-subscription': () => t('config.fixedConnection.anthropicSubscription'),
  'openai-compatible': () => t('config.fixedConnection.openaiCompatible'),
  'anthropic-compatible': () => t('config.fixedConnection.anthropicCompatible'),
  gemini: () => t('config.fixedConnection.gemini'),
}) satisfies Record<string, string>

export function fixedFactsLine(connectionLabel: string): string {
  return t('config.fixedFacts', { connection: connectionLabel })
}

/** A saved model's settings in its open row; Model and Base URL share the add flow's labels. */
export const MODEL_SETTING_LABELS = textTable({
  vision: () => t('config.modelSetting.vision'),
  contextWindow: () => t('config.modelSetting.contextWindow'),
}) satisfies Record<string, string>

export const MODEL_SETTING_HELP = textTable({
  vision: () => t('config.modelSettingHelp.vision'),
  contextWindow: () => t('config.modelSettingHelp.contextWindow'),
}) satisfies Record<string, string>

export const HEADER_FIELD_LABELS = textTable({
  name: () => t('config.headerField.name'),
  value: () => t('config.headerField.value'),
}) satisfies Record<string, string>

export const SAVE_HEADER_LABEL = 'Save header'
export const DISCARD_HEADER_LABEL = 'Discard header'
export const HEADER_NAME_REQUIRED_ERROR = 'A header needs a name.'

export function headerNameTakenError(name: string): string {
  return t('config.headerNameTaken', { name })
}

/** The accessible name of a saved header's name field. */
export function headerNameFieldName(header: string): string {
  return t('config.headerNameFieldName', { header })
}

/** A saved header's accessible label, so each name field, eye and Replace value names its header. */
export function modelHeaderLabel(header: string): string {
  return t('config.modelHeader', { header })
}

export const DEFAULT_CANNOT_DELETE_LINE = 'This is the default model. Make another model the default first.'
export const NO_MODELS_TEXT = 'Runs need a model. Add one to get started.'
export const NO_DEFAULT_TEXT = 'No default model. Runs need one — make one of these the default.'

/** A failed test shows providerErrorSentence instead, so `failed` has no entry here. */
export const TEST_RESULT_TEXT = textTable({
  testing: () => t('config.testResult.testing'),
  connected: () => t('config.testResult.connected'),
  'connected-without-key': () => t('config.testResult.connectedWithoutKey'),
}) satisfies Partial<Record<TestResult, string>>

export const CONNECT_LABEL = 'Connect'
export const CONNECTING_LABEL = 'Connecting…'
export const CONNECT_FORM_LEGEND = 'How do you connect?'

export const CONNECTION_CHOICE_LABELS = textTable({
  'chatgpt-sign-in': () => t('config.connectionChoice.chatgptSignIn'),
  'claude-sign-in': () => t('config.connectionChoice.claudeSignIn'),
  'openai-compatible-key': () => t('config.connectionChoice.openaiCompatibleKey'),
  'anthropic-compatible-key': () => t('config.connectionChoice.anthropicCompatibleKey'),
  'gemini-key': () => t('config.connectionChoice.geminiKey'),
}) satisfies Record<ConnectionChoice, string>

export const CONNECTION_CHOICE_HINTS = textTable({
  'chatgpt-sign-in': () => t('config.connectionChoiceHints.chatgptSignIn'),
  'claude-sign-in': () => t('config.connectionChoiceHints.claudeSignIn'),
  'openai-compatible-key': () => t('config.connectionChoiceHints.openaiCompatibleKey'),
  'anthropic-compatible-key': () => t('config.connectionChoiceHints.anthropicCompatibleKey'),
  'gemini-key': () => t('config.connectionChoiceHints.geminiKey'),
}) satisfies Record<ConnectionChoice, string>

export const ADD_FLOW_FIELD_LABELS = textTable({
  baseUrl: () => t('config.addFlowField.baseUrl'),
  model: () => t('config.addFlowField.model'),
  apiKey: () => t('config.addFlowField.apiKey'),
  keyType: () => t('config.addFlowField.keyType'),
  key: () => t('config.addFlowField.key'),
  token: () => t('config.addFlowField.token'),
  headers: () => t('config.addFlowField.headers'),
  name: () => t('config.addFlowField.name'),
  signInCode: () => t('config.addFlowField.signInCode'),
}) satisfies Record<string, string>

export const ADD_HEADER_LABEL = 'Add header'

export type CredentialKeyType = 'api-key' | 'bearer-token'

export const KEY_TYPE_LABELS = textTable({
  'api-key': () => t('config.keyType.apiKey'),
  'bearer-token': () => t('config.keyType.bearerToken'),
}) satisfies Record<CredentialKeyType, string>

export const KEY_OPTIONAL_HELP = "Leave empty if your endpoint doesn't need a key."
export const BASE_URL_HELP = "The exact base URL. agent-qa doesn't add paths to it."

export function existingCredentialLine(kind: 'key' | 'sign-in', name: string): string {
  return kind === 'key'
    ? t('config.existingCredential.key', { name })
    : t('config.existingCredential.signIn', { name })
}

export const NAME_RULE_ERROR = 'Use lowercase letters, digits, hyphens and dots, starting with a letter or digit.'

export function nameTakenError(name: string): string {
  return t('config.nameTaken', { name })
}

export function nameCredentialConflictError(name: string, providerLabel: string): string {
  return t('config.nameCredentialConflict', { name, provider: providerLabel })
}

export const MODEL_REQUIRED_ERROR = 'Model is required.'
export const KEY_REQUIRED_ERROR = 'API key is required.'
export const BASE_URL_REQUIRED_ERROR = 'Base URL is required for compatible providers.'

/** Every code POST /api/llm/connect can refuse with, including the route's own two. */
export type ConnectRefusalCode = LlmSetupRefusal | ConfigWriteRefusal | 'connect_failed' | 'cross_site_refused'

const COULD_NOT_SAVE_MODEL = "Couldn't save the model. Try again."

export const CONNECT_REFUSAL_COPY = textTable({
  invalid_setup_input: () => t('config.connectRefusal.invalidSetupInput'),
  name_invalid: () => NAME_RULE_ERROR,
  name_taken: () => t('config.connectRefusal.nameTaken'),
  credential_provider_conflict: () => t('config.connectRefusal.credentialProviderConflict'),
  credential_not_accepted: () => t('config.connectRefusal.credentialNotAccepted'),
  credential_missing: () => KEY_REQUIRED_ERROR,
  credential_exists: () => t('config.connectRefusal.credentialExists'),
  validation_failed: () => t('config.connectRefusal.validationFailed'),
  file_invalid: () => t('config.connectRefusal.fileInvalid'),
  invalid_write_input: () => COULD_NOT_SAVE_MODEL,
  path_not_found: () => COULD_NOT_SAVE_MODEL,
  write_failed: () => COULD_NOT_SAVE_MODEL,
  field_changed: () => COULD_NOT_SAVE_MODEL,
  path_not_writable: () => COULD_NOT_SAVE_MODEL,
  marker_written_back: () => MARKER_WRITTEN_BACK_SENTENCE,
  connect_failed: () => COULD_NOT_SAVE_MODEL,
  cross_site_refused: () => t('config.connectRefusal.crossSiteRefused'),
}) satisfies Record<ConnectRefusalCode, string>

const REFUSALS_WITH_ISSUES: Partial<Record<ConnectRefusalCode, (issue: string) => string>> = {
  validation_failed: (issue) => t('config.connectRefusalIssue.validationFailed', { issue }),
  invalid_setup_input: (issue) => t('config.connectRefusalIssue.invalidSetupInput', { issue }),
}

function isConnectRefusalCode(code: string): code is ConnectRefusalCode {
  return Object.prototype.hasOwnProperty.call(CONNECT_REFUSAL_COPY, code)
}

/** The network sentence only when the server named no reason this page knows. */
export function connectRefusalSentence(
  code: string | undefined,
  issues?: readonly { message: string }[],
): string {
  if (code === undefined || !isConnectRefusalCode(code)) return providerErrorSentence('network_error', '')
  const first = issues?.[0]?.message
  const withIssue = REFUSALS_WITH_ISSUES[code]
  return withIssue && first ? withIssue(first) : CONNECT_REFUSAL_COPY[code]
}

export const SIGN_IN_WAITING_TEXT = 'Finish signing in on the page that opened.'
export const CANCEL_SIGN_IN_LABEL = 'Cancel sign-in'
export const SIGN_IN_WAITING_LABEL = 'Waiting for sign-in…'
export const SIGN_IN_TIMED_OUT_TEXT = 'Sign-in timed out. Try again.'

export function signInFailedText(reason: string | undefined): string {
  return reason ? t('config.signInFailed.reason', { reason }) : t('config.signInFailed.noReason')
}

export function connectedSavedText(name: string): string {
  return t('config.connectedSaved', { name })
}

export const BECAME_DEFAULT_TEXT = "It's now the default model."
/** A sign-in choice whose auth plugin is not registered; the CLI names the same package. */
export function signInPluginMissingText(choiceLabel: string): string {
  return t('config.signInPluginMissing', { choice: choiceLabel })
}

export const SAVE_WITHOUT_TESTING_LABEL = 'Save without testing'
export const SAVED_WITHOUT_TEST_TEXT = 'Saved without a connection test.'

export const APPLY_LABEL = 'Apply'
export const KEEP_CURRENT_PATH_LABEL = 'Keep current path'

/** The one-word Apply button's accessible name names the path it applies. */
export function applyActionName(pathLabel: string): string {
  return t('config.applyAction', { path: pathLabel })
}

/** Keep current path's accessible name, so each data-path field's button names its own path. */
export function keepPathName(pathLabel: string): string {
  return t('config.keepPath', { path: pathLabel })
}

export type DataPathKey = 'knowledge.dir' | 'services.dashboard.dbPath' | 'services.dashboard.artifactsDir'

// What applying a new data path changes, as the code does it.
export const APPLY_CONSEQUENCES = textTable({
  'knowledge.dir': () => t('config.applyConsequences.knowledgeDir'),
  'services.dashboard.dbPath': () => t('config.applyConsequences.dbPath'),
  'services.dashboard.artifactsDir': () => t('config.applyConsequences.artifactsDir'),
}) satisfies Record<DataPathKey, string>

export const PORT_RESTART_HELP = 'Takes effect after the dashboard restarts.'

export const KNOWLEDGE_FIELD_LABELS = textTable({
  dir: () => t('config.knowledgeField.dir'),
})

export const KNOWLEDGE_FIELD_HELP = textTable({
  dir: () => t('config.knowledgeFieldHelp.dir'),
})

export const DASHBOARD_FIELD_LABELS = textTable({
  port: () => t('config.dashboardField.port'),
  host: () => t('config.dashboardField.host'),
  dbPath: () => t('config.dashboardField.dbPath'),
  artifactsDir: () => t('config.dashboardField.artifactsDir'),
  baseUrl: () => t('config.dashboardField.baseUrl'),
  workspace: () => t('config.dashboardField.workspace'),
})

export const DASHBOARD_FIELD_HELP = textTable({
  host: () => t('config.dashboardFieldHelp.host'),
  baseUrl: () => t('config.dashboardFieldHelp.baseUrl'),
  workspace: () => t('config.dashboardFieldHelp.workspace'),
})

export const TEST_DISCOVERY_FIELD_LABELS = textTable({
  testMatch: () => t('config.testDiscoveryField.testMatch'),
  suiteMatch: () => t('config.testDiscoveryField.suiteMatch'),
  testPathIgnore: () => t('config.testDiscoveryField.testPathIgnore'),
})

export const TEST_DISCOVERY_FIELD_HELP = textTable({
  testMatch: () => t('config.testDiscoveryFieldHelp.testMatch'),
  suiteMatch: () => t('config.testDiscoveryFieldHelp.suiteMatch'),
  testPathIgnore: () => t('config.testDiscoveryFieldHelp.testPathIgnore'),
})

export const TEST_MATCH_REQUIRED_ERROR = 'Add at least one pattern for test files.'
export const SUITE_MATCH_REQUIRED_ERROR = 'Add at least one pattern for suite files.'

export const FILES_FIELD_LABELS = textTable({
  hooksFile: () => t('config.filesField.hooksFile'),
  envFile: () => t('config.filesField.envFile'),
  secretsFile: () => t('config.filesField.secretsFile'),
})

export const FILES_FIELD_HELP = textTable({
  hooksFile: () => t('config.filesFieldHelp.hooksFile'),
  envFile: () => t('config.filesFieldHelp.envFile'),
  secretsFile: () => t('config.filesFieldHelp.secretsFile'),
})

export const HOOKS_FILE_REQUIRED_ERROR = 'Hooks file is required.'
export const ENV_FILE_REQUIRED_ERROR = 'Environment file is required.'

export const LOGGING_FIELD_LABELS = textTable({
  level: () => t('config.loggingField.level'),
})

export const LOGGING_FIELD_HELP = textTable({
  level: () => t('config.loggingFieldHelp.level'),
})

/** Runs print at Warning when the level is unset. */
export const LOGGING_LEVEL_LABELS = textTable({
  silent: () => t('config.loggingLevel.silent'),
  error: () => t('config.loggingLevel.error'),
  warn: () => t('config.loggingLevel.warn'),
  info: () => t('config.loggingLevel.info'),
  debug: () => t('config.loggingLevel.debug'),
})

export const PASS_RATE_SCOPE_HELP = 'Scoped pass rates count only runs whose attributes match every one of these.'
export const NO_ATTRIBUTES_TEXT = 'No attributes yet.'
export const ADD_ATTRIBUTE_LABEL = 'Add attribute'
export const MATCH_AS_PATTERN_LABEL = 'Match as a pattern'
/** Beside an attribute's key when its value is matched as a pattern. */
export const ATTRIBUTE_PATTERN_TAG = 'Pattern'
export const INVALID_ATTRIBUTE_PATTERN_ERROR = 'Not a valid pattern.'

export const ATTRIBUTE_FIELD_LABELS = textTable({
  key: () => t('config.attributeField.key'),
  value: () => t('config.attributeField.value'),
}) satisfies Record<string, string>

/** An attribute value's accessible label, so each eye and Replace value names its own attribute. */
export function attributeValueLabel(key: string): string {
  return `${key} value`
}

export function removeAttributeName(key: string): string {
  return `Remove attribute ${key}`
}

export const PRIVACY_FIELD_LABELS = textTable({
  privacy: () => t('config.privacyField.privacy'),
})

export const PRIVACY_FIELD_HELP = textTable({
  privacy: () => t('config.privacyFieldHelp.privacy'),
})

/** A duration field's draft error: the forms the field accepts. */
export const DURATION_INPUT_ERROR = 'Use a duration like 30s, 5m or 1h.'

export const BROWSER_FIELD_LABELS = textTable({
  name: () => t('config.browserField.name'),
  headless: () => t('config.browserField.headless'),
  viewportWidth: () => t('config.browserField.viewportWidth'),
  viewportHeight: () => t('config.browserField.viewportHeight'),
})

export const BROWSER_NAME_LABELS = textTable({
  chromium: () => 'Chromium',
  firefox: () => 'Firefox',
  webkit: () => 'WebKit',
})

export const HEADLESS_HELP = 'Run web browsers without a visible window.'

export const VISION_FIELD_LABELS = textTable({
  screenshotSize: () => t('config.visionField.screenshotSize'),
  effectiveResolution: () => t('config.visionField.effectiveResolution'),
})

export const VISION_FIELD_HELP = textTable({
  screenshotSize: () => t('config.visionFieldHelp.screenshotSize'),
  effectiveResolution: () => t('config.visionFieldHelp.effectiveResolution'),
})

export const PLANNER_FIELD_LABELS = textTable({
  maxActions: () => t('config.plannerField.maxActions'),
  maxPlanningTurns: () => t('config.plannerField.maxPlanningTurns'),
  previousStepCount: () => t('config.plannerField.previousStepCount'),
})

export const PLANNER_FIELD_HELP = textTable({
  maxActions: () => t('config.plannerFieldHelp.maxActions'),
  maxPlanningTurns: () => t('config.plannerFieldHelp.maxPlanningTurns'),
  previousStepCount: () => t('config.plannerFieldHelp.previousStepCount'),
})

export const TIMEOUT_FIELD_LABELS = textTable({
  step: () => t('config.timeoutField.step'),
  test: () => t('config.timeoutField.test'),
  navigation: () => t('config.timeoutField.navigation'),
})

export const TIMEOUT_FIELD_HELP = textTable({
  navigation: () => t('config.timeoutFieldHelp.navigation'),
})

export const RUNS_FIELD_LABELS = textTable({
  parallel: () => t('config.runsField.parallel'),
  workers: () => t('config.runsField.workers'),
  buildTag: () => t('config.runsField.buildTag'),
})

export const RUNS_FIELD_HELP = textTable({
  parallel: () => t('config.runsFieldHelp.parallel'),
  workers: () => t('config.runsFieldHelp.workers'),
  buildTag: () => t('config.runsFieldHelp.buildTag'),
})

export const CACHE_FIELD_LABELS = textTable({
  enabled: () => t('config.cacheField.enabled'),
  dir: () => t('config.cacheField.dir'),
})

export const RECORDING_FIELD_LABELS = textTable({
  enabled: () => t('config.recordingField.enabled'),
  keepFailuresOnly: () => t('config.recordingField.keepFailuresOnly'),
})

export const RECORDING_FIELD_HELP = textTable({
  enabled: () => t('config.recordingFieldHelp.enabled'),
  keepFailuresOnly: () => t('config.recordingFieldHelp.keepFailuresOnly'),
})

export const ACCESSIBILITY_FIELD_LABELS = textTable({
  enabled: () => t('config.accessibilityField.enabled'),
  standard: () => t('config.accessibilityField.standard'),
  runAfter: () => t('config.accessibilityField.runAfter'),
  failOnViolation: () => t('config.accessibilityField.failOnViolation'),
  disableRules: () => t('config.accessibilityField.disableRules'),
  exclude: () => t('config.accessibilityField.exclude'),
})

export const ACCESSIBILITY_FIELD_HELP = textTable({
  disableRules: () => t('config.accessibilityFieldHelp.disableRules'),
  exclude: () => t('config.accessibilityFieldHelp.exclude'),
})

export const ACCESSIBILITY_FIELD_PLACEHOLDERS = textTable({
  disableRules: () => 'color-contrast',
  exclude: () => '#cookie-banner',
})

export const ACCESSIBILITY_STANDARD_LABELS = textTable({
  wcag2a: () => 'WCAG 2.0 A',
  wcag2aa: () => 'WCAG 2.0 AA',
  wcag2aaa: () => 'WCAG 2.0 AAA',
})

export const ACCESSIBILITY_ALL_RULES_TEXT = 'All rules'

export const ACCESSIBILITY_RUN_AFTER_LABELS = textTable({
  'every-step': () => t('config.accessibilityRunAfter.everyStep'),
  'test-end': () => t('config.accessibilityRunAfter.testEnd'),
})

export const LOG_CAPTURE_FIELD_LABELS = textTable({
  console: () => t('config.logCaptureField.console'),
  network: () => t('config.logCaptureField.network'),
})

export const NO_TARGETS_TEXT = 'No targets yet.'

export const REMOTES_COPY = textTable({
  defaultLabel: () => t('config.remotes.defaultLabel'),
  inherit: () => t('config.remotes.inherit'),
  thisMachine: () => t('config.remotes.thisMachine'),
  runsOnLabel: () => t('config.remotes.runsOnLabel'),
  suiteWinsHint: () => t('config.remotes.suiteWinsHint'),
  // A url remote's protocol or a plugin remote's plugins entry, and its origin or plugin source.
  columns: () =>
    textTable({
      name: () => t('config.remotes.columns.name'),
      kind: () => t('config.remotes.columns.kind'),
      origin: () => t('config.remotes.columns.origin'),
    }),
  missingValue: () => '—',
  pluginNotDeclared: () => t('config.remotes.pluginNotDeclared'),
  empty: () => t('config.remotes.empty'),
  example: () =>
    [
      'registry:',
      '  remotes:',
      '    - name: grid',
      '      protocol: playwright # or cdp',
      '      url: wss://grid.example.com/playwright',
      '      query: # or headers, with the same {{secret:NAME}} values',
      '        token: "{{secret:GRID_TOKEN}}"',
    ].join('\n'),
  pick: () => t('config.remotes.pick'),
  listed: () => t('config.remotes.listed'),
  pluginsTitle: () => t('config.remotes.pluginsTitle'),
  pluginColumns: () =>
    textTable({
      name: () => t('config.remotes.pluginColumns.name'),
      source: () => t('config.remotes.pluginColumns.source'),
    }),
  pluginsListed: () => t('config.remotes.pluginsListed'),
})

export function pluginRemoteText(entry: string): string {
  return `plugin ${entry}`
}

// The strict parse refuses this default, but the page still shows a config that fails to parse.
export function remoteNotListedParts<T>(name: T): [T, string] {
  return [
    name,
    ' is not listed under registry.remotes, so web tests that use this default cannot run. List it, or change use.browser.remote.',
  ]
}

export function remoteUnlistedChoiceParts<T>(name: T): [T, string] {
  return [name, ' (not listed)']
}

export function remotePickNotListedParts<T>(name: T): [T, string] {
  return [name, " is not listed under the config's remotes."]
}

export function remoteChoiceParts<T>(name: T, protocol: string | undefined): [T, string] {
  return [name, protocol === undefined ? '' : ` (${protocol})`]
}

export function remoteCredentialsLine(secretsFile: string | undefined): string {
  const file = secretsFile ?? 'your secrets file (set workspace.secretsFile)'
  return `Write credentials as {{secret:NAME}} references to names declared in ${file}.`
}
export const NO_DEVICES_TEXT = 'No devices yet.'
export const NO_LOGIN_STATES_TEXT = 'No saved login states yet. Save one from a web Live Mode session.'
export const LOGIN_STATES_LOADING_TEXT = 'Loading saved login states…'
export const LOGIN_STATES_LOAD_FAILED_TEXT = "Couldn't load saved login states."
export const RELOAD_LOGIN_STATES_LABEL = 'Reload login states'

export const LOGIN_STATE_COLUMN_LABELS = textTable({
  target: () => t('config.loginStateColumn.target'),
  name: () => t('config.loginStateColumn.name'),
  captured: () => t('config.loginStateColumn.captured'),
}) satisfies Record<string, string>

export const LOGIN_STATES_FIELD_LABELS = textTable({
  dir: () => t('config.loginStatesField.dir'),
})

export const LOGIN_STATES_DIR_PLACEHOLDER = '.agent-qa/auth-states'
export const LOGIN_STATES_DIR_REQUIRED_ERROR = 'Add a folder for saved login states.'

export const MOBILE_FIELD_LABELS = textTable({
  appState: () => t('config.mobileField.appState'),
})

export const MOBILE_APP_STATE_LABELS = textTable({
  preserve: () => t('config.mobileAppState.preserve'),
  reset: () => t('config.mobileAppState.reset'),
}) satisfies Record<'preserve' | 'reset', string>

export const MOBILE_APP_STATE_HELP = 'Mobile runs need this choice.'

export const ADD_TARGET_LABEL = 'Add target'
export const DISCARD_TARGET_LABEL = 'Discard target'
export const ADD_DEVICE_LABEL = 'Add device'
export const DISCARD_DEVICE_LABEL = 'Discard device'

export const TARGET_PLATFORM_LABELS = textTable({
  web: () => t('config.targetPlatform.web'),
  android: () => 'Android',
  ios: () => 'iOS',
}) satisfies Record<'web' | 'android' | 'ios', string>

export const TARGET_ENVIRONMENT_LABELS = textTable({
  local: () => t('config.targetEnvironment.local'),
  shared: () => t('config.targetEnvironment.shared'),
  production: () => t('config.targetEnvironment.production'),
}) satisfies Record<'local' | 'shared' | 'production', string>

export const TARGET_ENVIRONMENT_PLACEHOLDER = 'Undeclared'

/** The add-target row's environment choices: undeclared first, then the declared classes. */
export const TARGET_ENVIRONMENT_CHOICE_LABELS = textTable({
  undeclared: () => t('config.targetEnvironmentChoice.undeclared'),
  local: () => TARGET_ENVIRONMENT_LABELS.local,
  shared: () => TARGET_ENVIRONMENT_LABELS.shared,
  production: () => TARGET_ENVIRONMENT_LABELS.production,
}) satisfies Record<'undeclared' | 'local' | 'shared' | 'production', string>

export const TARGET_FIELD_LABELS = textTable({
  name: () => t('config.targetField.name'),
  platform: () => t('config.targetField.platform'),
  url: () => t('config.targetField.url'),
  product: () => t('config.targetField.product'),
  bundleId: () => t('config.targetField.bundleId'),
  appPackage: () => t('config.targetField.appPackage'),
  appActivity: () => t('config.targetField.appActivity'),
  appPath: () => t('config.targetField.appPath'),
  appRef: () => t('config.targetField.appRef'),
  device: () => t('config.targetField.device'),
  environment: () => t('config.targetField.environment'),
}) satisfies Record<string, string>

export const TARGET_DEVICE_NONE = 'None'
export const TARGET_DEVICE_HELP =
  'Tests on this target run on this device unless a suite or test picks another.'
export const TARGET_APP_REF_NOTE =
  'The app a remote device installs. Set it in agent-qa.config.yaml; this page shows it read-only.'

/** A target's device that no device of the target's platform matches, kept in its select. */
export function targetDeviceUnlistedChoice(name: string): string {
  return `${name} (not listed for this platform)`
}

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

export const DEVICE_FIELD_LABELS = textTable({
  name: () => t('config.deviceField.name'),
  platform: () => t('config.deviceField.platform'),
  model: () => t('config.deviceField.model'),
  os: () => t('config.deviceField.os'),
  id: () => t('config.deviceField.id'),
  capabilities: () => t('config.deviceField.capabilities'),
}) satisfies Record<string, string>

export const DEVICE_NAME_REQUIRED_ERROR = 'Add a name for the device.'

export function deviceNameTakenError(name: string): string {
  return `A device named ${name} already exists.`
}

export const DEVICE_ID_HELP =
  'Needed only when two identical devices are attached at once: an Android serial or an iOS simulator udid.'
export const DEVICE_CAPABILITIES_NOTE =
  'Set capabilities in agent-qa.config.yaml; this page shows them read-only.'

/** A capability's accessible label, so each value names its own device and key. */
export function deviceCapabilityLabel(device: string, key: string): string {
  return `${device} capability ${key}`
}

/** A device's remote, shown read-only: pointing a device at a server is a file edit. */
export function deviceRemoteText(remote: string): string {
  return `Runs on remote ${remote}`
}

export const MCP_FIELD_LABELS = textTable({
  enabled: () => t('config.mcpField.enabled'),
  port: () => t('config.mcpField.port'),
}) satisfies Record<string, string>

export const MCP_FIELD_HELP = textTable({
  enabled: () => t('config.mcpFieldHelp.enabled'),
}) satisfies Record<string, string>

// MCP and the run service are tokenless, so this copy has no token rows.

export const CONFIG_FILE_NOTE = 'Read-only. Edit the file in your editor; changes show here by themselves.'
export const COPY_PATH_LABEL = 'Copy config file path'

export const COPY_STATUS_WORDS = textTable({
  copied: () => t('config.copyStatus.copied'),
  failed: () => t('config.copyStatus.failed'),
}) satisfies Record<'copied' | 'failed', string>

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

export const TOUR_LLM_SETUP_BODY =
  "A run needs a model. Add one: choose how you connect, and it's tested and saved as soon as it works."
