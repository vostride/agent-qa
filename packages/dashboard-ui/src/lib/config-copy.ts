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

export const CONFIG_PAGE_TITLE = () => t('configUi.configPageTitle')
export const VERSION_UNAVAILABLE_TEXT = () => t('configUi.versionUnavailableText')

export const CONFIG_TAB_LABELS = textTable({
  models: () => t('config.tabs.models'),
  targets: () => t('config.tabs.targets'),
  execution: () => t('config.tabs.execution'),
  project: () => t('config.tabs.project'),
  advanced: () => t('config.tabs.advanced'),
}) satisfies Record<ConfigTab, string>

export const CONFIG_TABS_ARIA_LABEL = () => t('configUi.configTabsAriaLabel')
export const TAB_DRAFT_SR_SUFFIX = () => t('configUi.tabDraftSrSuffix')

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

export const LEGACY_LINK_NOT_FOUND_TEXT = () => t('configUi.legacyLinkNotFoundText')

export const CONFIG_LOAD_FAILED_TITLE = () => t('configUi.configLoadFailedTitle')

export function configLoadFailedBody(reason: string): string {
  return t('config.loadFailedBody', { reason })
}

export const RELOAD_CONFIG_LABEL = () => t('configUi.reloadConfigLabel')

/** The file parses but fails whole-config validation: one notice above the tabs. */
export const CONFIG_FILE_ISSUES_TITLE = () => t('configUi.configFileIssuesTitle')

export function configFileIssuesBody(reason: string): string {
  return t('config.fileIssuesBody', { reason })
}

export const SAVE_STATUS_WORDS = textTable({
  saving: () => t('config.saveStatus.saving'),
  saved: () => t('config.saveStatus.saved'),
  draft: () => t('config.saveStatus.draft'),
  failed: () => t('config.saveStatus.failed'),
}) satisfies Partial<Record<SaveState, string>>

export const RETRY_LABEL = () => t('configUi.retryLabel')
export const NOT_SAVED_ACTION_NAME = () => t('configUi.notSavedActionName')
export const UNDO_LABEL = () => t('configUi.undoLabel')
/** A computed write the file changed under twice in a row; the page has re-read it. */
export const FIELD_CHANGED_TEXT = () => t('configUi.fieldChangedText')

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

export const ADD_MODEL_LABEL = () => t('configUi.addModelLabel')
export const NEW_MODEL_ROW_TITLE = () => t('configUi.newModelRowTitle')
export const DISCARD_DRAFT_LABEL = () => t('configUi.discardDraftLabel')

export const MODEL_STATUS_WORDS = textTable({
  'signed-in': () => t('config.modelStatus.signedIn'),
  'key-saved': () => t('config.modelStatus.keySaved'),
  'not-connected': () => t('config.modelStatus.notConnected'),
  'sign-in-expired': () => t('config.modelStatus.signInExpired'),
}) satisfies Record<ModelStatus, string>

export const DEFAULT_BADGE = () => t('configUi.defaultBadge')

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

export const TEST_CONNECTION_LABEL = () => t('configUi.testConnectionLabel')
export const MAKE_DEFAULT_LABEL = () => t('configUi.makeDefaultLabel')
export const REPLACE_KEY_LABEL = () => t('configUi.replaceKeyLabel')
export const REMOVE_KEY_LABEL = () => t('configUi.removeKeyLabel')
export const SIGN_IN_AGAIN_LABEL = () => t('configUi.signInAgainLabel')
export const SIGN_OUT_LABEL = () => t('configUi.signOutLabel')
export const DELETE_MODEL_LABEL = () => t('configUi.deleteModelLabel')
export const SAVE_KEY_AND_TEST_LABEL = () => t('configUi.saveKeyAndTestLabel')
export const KEEP_CURRENT_KEY_LABEL = () => t('configUi.keepCurrentKeyLabel')
export const NEW_KEY_LABEL = () => t('configUi.newKeyLabel')

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

export const SAVE_HEADER_LABEL = () => t('configUi.saveHeaderLabel')
export const DISCARD_HEADER_LABEL = () => t('configUi.discardHeaderLabel')
export const HEADER_NAME_REQUIRED_ERROR = () => t('configUi.headerNameRequiredError')

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

export const DEFAULT_CANNOT_DELETE_LINE = () => t('configUi.defaultCannotDeleteLine')
export const NO_MODELS_TEXT = () => t('configUi.noModelsText')
export const NO_DEFAULT_TEXT = () => t('configUi.noDefaultText')

/** A failed test shows providerErrorSentence instead, so `failed` has no entry here. */
export const TEST_RESULT_TEXT = textTable({
  testing: () => t('config.testResult.testing'),
  connected: () => t('config.testResult.connected'),
  'connected-without-key': () => t('config.testResult.connectedWithoutKey'),
}) satisfies Partial<Record<TestResult, string>>

export const CONNECT_LABEL = () => t('configUi.connectLabel')
export const CONNECTING_LABEL = () => t('configUi.connectingLabel')
export const CONNECT_FORM_LEGEND = () => t('configUi.connectFormLegend')

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

export const ADD_HEADER_LABEL = () => t('configUi.addHeaderLabel')

export type CredentialKeyType = 'api-key' | 'bearer-token'

export const KEY_TYPE_LABELS = textTable({
  'api-key': () => t('config.keyType.apiKey'),
  'bearer-token': () => t('config.keyType.bearerToken'),
}) satisfies Record<CredentialKeyType, string>

export const KEY_OPTIONAL_HELP = () => t('configUi.keyOptionalHelp')
export const BASE_URL_HELP = () => t('configUi.baseUrlHelp')

export function existingCredentialLine(kind: 'key' | 'sign-in', name: string): string {
  return kind === 'key'
    ? t('config.existingCredential.key', { name })
    : t('config.existingCredential.signIn', { name })
}

export const NAME_RULE_ERROR = () => t('configUi.nameRuleError')

export function nameTakenError(name: string): string {
  return t('config.nameTaken', { name })
}

export function nameCredentialConflictError(name: string, providerLabel: string): string {
  return t('config.nameCredentialConflict', { name, provider: providerLabel })
}

export const MODEL_REQUIRED_ERROR = () => t('configUi.modelRequiredError')
export const KEY_REQUIRED_ERROR = () => t('configUi.keyRequiredError')
export const BASE_URL_REQUIRED_ERROR = () => t('configUi.baseUrlRequiredError')

/** Every code POST /api/llm/connect can refuse with, including the route's own two. */
export type ConnectRefusalCode = LlmSetupRefusal | ConfigWriteRefusal | 'connect_failed' | 'cross_site_refused'

const COULD_NOT_SAVE_MODEL = () => t('configUi.couldNotSaveModel')

export const CONNECT_REFUSAL_COPY = textTable({
  invalid_setup_input: () => t('config.connectRefusal.invalidSetupInput'),
  name_invalid: () => NAME_RULE_ERROR(),
  name_taken: () => t('config.connectRefusal.nameTaken'),
  credential_provider_conflict: () => t('config.connectRefusal.credentialProviderConflict'),
  credential_not_accepted: () => t('config.connectRefusal.credentialNotAccepted'),
  credential_missing: () => KEY_REQUIRED_ERROR(),
  credential_exists: () => t('config.connectRefusal.credentialExists'),
  validation_failed: () => t('config.connectRefusal.validationFailed'),
  file_invalid: () => t('config.connectRefusal.fileInvalid'),
  invalid_write_input: () => COULD_NOT_SAVE_MODEL(),
  path_not_found: () => COULD_NOT_SAVE_MODEL(),
  write_failed: () => COULD_NOT_SAVE_MODEL(),
  field_changed: () => COULD_NOT_SAVE_MODEL(),
  path_not_writable: () => COULD_NOT_SAVE_MODEL(),
  marker_written_back: () => MARKER_WRITTEN_BACK_SENTENCE,
  connect_failed: () => COULD_NOT_SAVE_MODEL(),
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

export const SIGN_IN_WAITING_TEXT = () => t('configUi.signInWaitingText')
export const CANCEL_SIGN_IN_LABEL = () => t('configUi.cancelSignInLabel')
export const SIGN_IN_WAITING_LABEL = () => t('configUi.signInWaitingLabel')
export const SIGN_IN_TIMED_OUT_TEXT = () => t('configUi.signInTimedOutText')

export function signInFailedText(reason: string | undefined): string {
  return reason ? t('config.signInFailed.reason', { reason }) : t('config.signInFailed.noReason')
}

export function connectedSavedText(name: string): string {
  return t('config.connectedSaved', { name })
}

export function savedBecameDefaultText(saved: string): string {
  return t('configUi.savedBecameDefault', { saved })
}

/** A sign-in choice whose auth plugin is not registered; the CLI names the same package. */
export function signInPluginMissingText(choiceLabel: string): string {
  return t('config.signInPluginMissing', { choice: choiceLabel })
}

export const SAVE_WITHOUT_TESTING_LABEL = () => t('configUi.saveWithoutTestingLabel')
export const SAVED_WITHOUT_TEST_TEXT = () => t('configUi.savedWithoutTestText')

export const APPLY_LABEL = () => t('configUi.applyLabel')
export const KEEP_CURRENT_PATH_LABEL = () => t('configUi.keepCurrentPathLabel')

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

export const PORT_RESTART_HELP = () => t('configUi.portRestartHelp')

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

export const TEST_MATCH_REQUIRED_ERROR = () => t('configUi.testMatchRequiredError')
export const SUITE_MATCH_REQUIRED_ERROR = () => t('configUi.suiteMatchRequiredError')

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

export const HOOKS_FILE_REQUIRED_ERROR = () => t('configUi.hooksFileRequiredError')
export const ENV_FILE_REQUIRED_ERROR = () => t('configUi.envFileRequiredError')

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

export const PASS_RATE_SCOPE_HELP = () => t('configUi.passRateScopeHelp')
export const NO_ATTRIBUTES_TEXT = () => t('configUi.noAttributesText')
export const ADD_ATTRIBUTE_LABEL = () => t('configUi.addAttributeLabel')
export const MATCH_AS_PATTERN_LABEL = () => t('configUi.matchAsPatternLabel')
/** Beside an attribute's key when its value is matched as a pattern. */
export const ATTRIBUTE_PATTERN_TAG = () => t('configUi.attributePatternTag')
export const INVALID_ATTRIBUTE_PATTERN_ERROR = () => t('configUi.invalidAttributePatternError')

export const ATTRIBUTE_FIELD_LABELS = textTable({
  key: () => t('config.attributeField.key'),
  value: () => t('config.attributeField.value'),
}) satisfies Record<string, string>

/** An attribute value's accessible label, so each eye and Replace value names its own attribute. */
export function attributeValueLabel(key: string): string {
  return t('config.attributeValue', { key })
}

export function removeAttributeName(key: string): string {
  return t('config.removeAttribute', { key })
}

export const PRIVACY_FIELD_LABELS = textTable({
  privacy: () => t('config.privacyField.privacy'),
})

export const PRIVACY_FIELD_HELP = textTable({
  privacy: () => t('config.privacyFieldHelp.privacy'),
})

/** A duration field's draft error: the forms the field accepts. */
export const DURATION_INPUT_ERROR = () => t('configUi.durationInputError')

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

export const HEADLESS_HELP = () => t('configUi.headlessHelp')

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

export const ACCESSIBILITY_ALL_RULES_TEXT = () => t('configUi.accessibilityAllRulesText')

export const ACCESSIBILITY_RUN_AFTER_LABELS = textTable({
  'every-step': () => t('config.accessibilityRunAfter.everyStep'),
  'test-end': () => t('config.accessibilityRunAfter.testEnd'),
})

export const LOG_CAPTURE_FIELD_LABELS = textTable({
  console: () => t('config.logCaptureField.console'),
  network: () => t('config.logCaptureField.network'),
})

export const NO_TARGETS_TEXT = () => t('configUi.noTargetsText')

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
  pluginsTitle: () => t('config.remotes.pluginsTitle'),
  pluginColumns: () =>
    textTable({
      name: () => t('config.remotes.pluginColumns.name'),
      source: () => t('config.remotes.pluginColumns.source'),
    }),
})

export function pluginRemoteText(entry: string): string {
  return t('config.pluginRemote', { entry })
}

type NameSentenceKey = 'config.remoteUnlistedChoice' | 'config.remotePickNotListed'

// The sentence is split before the name goes in, so a name is never read for slots.
function nameSentenceParts<T>(key: NameSentenceKey, name: T): readonly (T | string)[] {
  const sentence = String(t(key, { skipInterpolation: true } as never))
  return sentence.split(/\{\{\s*name\s*\}\}/).flatMap((piece, index): (T | string)[] => {
    const before = index > 0 ? [name] : []
    return piece ? [...before, piece] : before
  })
}

export function remoteUnlistedChoiceParts<T>(name: T): readonly (T | string)[] {
  return nameSentenceParts('config.remoteUnlistedChoice', name)
}

export function remotePickNotListedParts<T>(name: T): readonly (T | string)[] {
  return nameSentenceParts('config.remotePickNotListed', name)
}

export function remoteChoiceParts<T>(name: T, protocol: string | undefined): [T, string] {
  return [name, protocol === undefined ? '' : ` (${protocol})`]
}

const REMOTES_NOTE_KEYS = {
  empty: 'config.remotes.empty',
  pick: 'config.remotes.pick',
  listed: 'config.remotes.listed',
  pluginsListed: 'config.remotes.pluginsListed',
} as const

type CodeSentenceKey =
  | (typeof REMOTES_NOTE_KEYS)[keyof typeof REMOTES_NOTE_KEYS]
  | 'config.remoteNotListed'
  | 'config.remoteCredentials.file'
  | 'config.remoteCredentials.noFile'

type CodeSpan<T> = (inner: readonly (T | string)[], index: number) => T

const CODE_AND_SLOT_MARKS = /(<code>|<\/code>|\{\{\s*\w+\s*\}\})/

// The catalog marks each config key with a bare <code> tag. The sentence is split at its marks
// and slots before any value goes in, so a value is never read for either.
function codeSentenceParts<T>(
  key: CodeSentenceKey,
  slots: Record<string, T | string>,
  code: CodeSpan<T>,
): readonly (T | string)[] {
  const sentence = String(t(key, { skipInterpolation: true } as never))
  const parts: (T | string)[] = []
  let span: (T | string)[] | undefined
  for (const [index, piece] of sentence.split(CODE_AND_SLOT_MARKS).entries()) {
    if (piece === '<code>') {
      span ??= []
    } else if (piece === '</code>') {
      if (span) parts.push(code(span, index))
      span = undefined
    } else if (piece !== '') {
      const slot = /^\{\{\s*(\w+)\s*\}\}$/.exec(piece)?.[1]
      const value = slot !== undefined && slot in slots ? slots[slot]! : piece
      if (span) span.push(value)
      else parts.push(value)
    }
  }
  return span ? [...parts, ...span] : parts
}

export function remotesNoteParts<T>(
  note: keyof typeof REMOTES_NOTE_KEYS,
  code: CodeSpan<T>,
): readonly (T | string)[] {
  return codeSentenceParts(REMOTES_NOTE_KEYS[note], {}, code)
}

// The strict parse refuses this default, but the page still shows a config that fails to parse.
export function remoteNotListedParts<T>(name: T, code: CodeSpan<T>): readonly (T | string)[] {
  return codeSentenceParts('config.remoteNotListed', { name }, code)
}

export function remoteCredentialsParts<T>(
  secretsFile: string | undefined,
  code: CodeSpan<T>,
): readonly (T | string)[] {
  const reference = '{{secret:NAME}}'
  return secretsFile === undefined
    ? codeSentenceParts('config.remoteCredentials.noFile', { reference }, code)
    : codeSentenceParts('config.remoteCredentials.file', { reference, file: secretsFile }, code)
}
export const NO_DEVICES_TEXT = () => t('configUi.noDevicesText')
export const NO_LOGIN_STATES_TEXT = () => t('configUi.noLoginStatesText')
export const LOGIN_STATES_LOADING_TEXT = () => t('configUi.loginStatesLoadingText')
export const LOGIN_STATES_LOAD_FAILED_TEXT = () => t('configUi.loginStatesLoadFailedText')
export const RELOAD_LOGIN_STATES_LABEL = () => t('configUi.reloadLoginStatesLabel')

export const LOGIN_STATE_COLUMN_LABELS = textTable({
  target: () => t('config.loginStateColumn.target'),
  name: () => t('config.loginStateColumn.name'),
  captured: () => t('config.loginStateColumn.captured'),
}) satisfies Record<string, string>

export const LOGIN_STATES_FIELD_LABELS = textTable({
  dir: () => t('config.loginStatesField.dir'),
})

export const LOGIN_STATES_DIR_PLACEHOLDER = () => t('configUi.loginStatesDirPlaceholder')
export const LOGIN_STATES_DIR_REQUIRED_ERROR = () => t('configUi.loginStatesDirRequiredError')

export const MOBILE_FIELD_LABELS = textTable({
  appState: () => t('config.mobileField.appState'),
})

export const MOBILE_APP_STATE_LABELS = textTable({
  preserve: () => t('config.mobileAppState.preserve'),
  reset: () => t('config.mobileAppState.reset'),
}) satisfies Record<'preserve' | 'reset', string>

export const MOBILE_APP_STATE_HELP = () => t('configUi.mobileAppStateHelp')

export const ADD_TARGET_LABEL = () => t('configUi.addTargetLabel')
export const DISCARD_TARGET_LABEL = () => t('configUi.discardTargetLabel')
export const ADD_DEVICE_LABEL = () => t('configUi.addDeviceLabel')
export const DISCARD_DEVICE_LABEL = () => t('configUi.discardDeviceLabel')

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

export const TARGET_ENVIRONMENT_PLACEHOLDER = () => t('configUi.targetEnvironmentPlaceholder')

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

export const TARGET_DEVICE_NONE = () => t('configUi.targetDeviceNone')
export const TARGET_DEVICE_HELP = () => t('configUi.targetDeviceHelp')
export const TARGET_APP_REF_NOTE = () => t('configUi.targetAppRefNote')

/** A target's device that no device of the target's platform matches, kept in its select. */
export function targetDeviceUnlistedChoice(name: string): string {
  return t('config.targetDeviceUnlistedChoice', { name })
}

export function targetAppSummary(path: string): string {
  return t('configUi.targetAppSummary', { path })
}

export function targetAppRefLabel(name: string): string {
  return t('configUi.targetAppRefLabel', { name })
}

export const TARGET_NAME_REQUIRED_ERROR = () => t('configUi.targetNameRequiredError')
export const TARGET_NAME_FORMAT_ERROR = () => t('configUi.targetNameFormatError')
export const TARGET_URL_REQUIRED_ERROR = () => t('configUi.targetUrlRequiredError')
export const TARGET_WEB_NEEDS_URL_ERROR = () => t('configUi.targetWebNeedsUrlError')
export const TARGET_PRODUCT_ERROR = () => t('configUi.targetProductError')
export const TARGET_APP_PATH_ERROR = () => t('configUi.targetAppPathError')

export function targetNameTakenError(name: string): string {
  return t('config.targetNameTaken', { name })
}

export const DEVICE_FIELD_LABELS = textTable({
  name: () => t('config.deviceField.name'),
  platform: () => t('config.deviceField.platform'),
  model: () => t('config.deviceField.model'),
  os: () => t('config.deviceField.os'),
  id: () => t('config.deviceField.id'),
  capabilities: () => t('config.deviceField.capabilities'),
}) satisfies Record<string, string>

export const DEVICE_NAME_REQUIRED_ERROR = () => t('configUi.deviceNameRequiredError')

export function deviceNameTakenError(name: string): string {
  return t('config.deviceNameTaken', { name })
}

export const DEVICE_ID_HELP = () => t('configUi.deviceIdHelp')
export const DEVICE_CAPABILITIES_NOTE = () => t('configUi.deviceCapabilitiesNote')

/** A capability's accessible label, so each value names its own device and key. */
export function deviceCapabilityLabel(device: string, key: string): string {
  return t('config.deviceCapability', { device, key })
}

/** A device's remote, shown read-only: pointing a device at a server is a file edit. */
export function deviceRemoteText(remote: string): string {
  return t('config.deviceRemote', { remote })
}

export const MCP_FIELD_LABELS = textTable({
  enabled: () => t('config.mcpField.enabled'),
  port: () => t('config.mcpField.port'),
}) satisfies Record<string, string>

export const MCP_FIELD_HELP = textTable({
  enabled: () => t('config.mcpFieldHelp.enabled'),
}) satisfies Record<string, string>

// MCP and the run service are tokenless, so this copy has no token rows.

export const CONFIG_FILE_NOTE = () => t('configUi.configFileNote')
export const COPY_PATH_LABEL = () => t('configUi.copyPathLabel')

export const COPY_STATUS_WORDS = textTable({
  copied: () => t('config.copyStatus.copied'),
  failed: () => t('config.copyStatus.failed'),
}) satisfies Record<'copied' | 'failed', string>

export const REPLACE_VALUE_LABEL = () => t('configUi.replaceValueLabel')
export const SAVE_VALUE_LABEL = () => t('configUi.saveValueLabel')
export const KEEP_CURRENT_VALUE_LABEL = () => t('configUi.keepCurrentValueLabel')

export function replaceValueName(label: string): string {
  return t('config.replaceValue', { label })
}

export function saveValueName(label: string): string {
  return t('config.saveValue', { label })
}

export function keepValueName(label: string): string {
  return t('config.keepValue', { label })
}

export const SAVE_SETTING_LABEL = () => t('configUi.saveSettingLabel')
export const DISCARD_SETTING_LABEL = () => t('configUi.discardSettingLabel')

export const TOUR_LLM_SETUP_BODY = () => t('configUi.tourLlmSetupBody')
