import type {
  ConsoleLogEntry,
  NetworkLogEntry,
  StepAnnotation,
  HookDefinition,
  ModelConfig,
  SecretRedactor,
  SecretStore,
} from '@vostride/agent-qa-core'

export type LiveSessionLLMConfig = Pick<
  ModelConfig,
  'provider' | 'model' | 'apiKey' | 'authToken' | 'baseURL' | 'providerHeaders'
> & {
  screenshotSize?: number
  effectiveResolution?: number
}

export interface LiveDraftMetadata {
  testName: string
  testContext?: string
}

// EntityRef — passed to SessionManager.createSession to enable the per-entity
// counter assignment. Ephemeral; counters live on the SessionManager map.
// [Phase 181.1 D-27, D-30]
export interface EntityRef {
  type: 'suite' | 'test'
  id: string
}

// LiveSuiteDraft — metadata the suite builder sends alongside execute-test
// events. Parallels LiveDraftMetadata at the suite level.
export interface LiveSuiteDraft {
  suiteName: string
  suiteContext?: string
}

export interface LiveExecutionLog {
  id: string
  type: 'hook' | 'appium-script' | 'runjs'
  name: string
  hookId?: string | null
  phase: 'setup' | 'teardown' | 'inline'
  status: 'passed' | 'failed'
  duration: number
  stdout: string | null
  stderr: string | null
  returnData: unknown | null
  variables: Record<string, string> | null
  createdAt: string
}

export interface LiveSubActionData {
  index: number
  observation: string
  reasoning: string
  plannedAction: unknown
  result: 'success' | 'failure' | 'in-progress'
  error?: string
  screenStateBefore: string
  screenStateAfter?: string
  confidence?: number
  verifierReasoning?: string
  cached: boolean
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  phaseDurations?: { observe?: number; plan?: number; execute?: number; verify?: number }
  annotation?: StepAnnotation
  screenContextBefore?: string
  screenContextAfter?: string
  data?: unknown
}

export interface LiveStepResultPayload {
  status: 'passed' | 'failed' | 'cancelled'
  duration?: number
  error?: string
  capturedVariables?: Record<string, string>
  variableSnapshot?: Record<string, { value: string; source: string }>
  originalStepName?: string
  consoleLogs?: ConsoleLogEntry[]
  networkLogs?: NetworkLogEntry[]
  executionLogs?: LiveExecutionLog[]
  subActionsData?: LiveSubActionData[]
}

export interface LiveSuiteHookOwner {
  scope: 'suite'
}

export interface LiveTestOwner {
  scope: 'test'
  testExecutionId: string
  testIndex: number
  testId: string
  testName: string
}

export type LiveHookOwner = LiveSuiteHookOwner | LiveTestOwner

export interface LiveHookPayload {
  executionId: string
  hookId: string
  hookName: string
  phase: 'setup' | 'teardown'
  owner: LiveHookOwner
  status: 'running' | 'passed' | 'failed'
  duration?: number
  stdout?: string | null
  stderr?: string | null
  variables?: Record<string, string> | null
  error?: string
  createdAt: string
}

export interface LiveTestExecutionPayload {
  testExecutionId: string
  testIndex: number
  testId: string
  testName: string
}

export interface LiveTestStepPayload extends LiveTestExecutionPayload {
  stepIndex: number
  stepInstruction: string
}

// Result emitted from LiveSession.executeTestCommand and forwarded on the
// test-complete WS message. [Phase 181.1 D-09, D-25]
export interface LiveTestResultPayload {
  status: 'passed' | 'failed' | 'cancelled'
  duration: number
  error?: string
  setupHookExecutions: LiveHookPayload[]
  stepResults: LiveStepResultPayload[]
  teardownHookExecutions: LiveHookPayload[]
}

export type ClientMessage =
  | { type: 'execute-step'; stepInstruction: string; stepIndex?: number; draft?: LiveDraftMetadata }
  | { type: 'execute-hook'; phase: 'setup' | 'teardown'; hookId: string }
  | {
      type: 'execute-test'
      testExecutionId: string
      testId: string
      path: string
      testIndex?: number
      draft?: LiveSuiteDraft
    }
  | { type: 'cancel-step' }
  | { type: 'terminate-session' }
  | { type: 'get-screenshot' }
  | { type: 'get-state' }
  | { type: 'navigate'; url: string }
  | { type: 'refresh-page' }
  | { type: 'go-back' }
  | { type: 'go-forward' }
  | { type: 'get-aria-tree' }

export type ServerMessage =
  | { type: 'session-ready'; sessionId: string; platform: string; interactive: boolean; error?: string | null }
  | { type: 'hook-start'; hook: LiveHookPayload }
  | { type: 'hook-complete'; hook: LiveHookPayload }
  | { type: 'step-phase'; phase: string; data?: unknown }
  | { type: 'step-complete'; result: LiveStepResultPayload }
  | { type: 'step-cancelled' }
  | { type: 'step-error'; error: string }
  | { type: 'test-start'; test: LiveTestExecutionPayload }
  | { type: 'test-step-start'; step: LiveTestStepPayload }
  | { type: 'test-step-phase'; step: LiveTestStepPayload; phase: string; data?: unknown }
  | { type: 'test-step-complete'; step: LiveTestStepPayload; result: LiveStepResultPayload }
  | { type: 'test-step-cancelled'; step: LiveTestStepPayload }
  | { type: 'test-step-error'; step: LiveTestStepPayload; error: string }
  | { type: 'test-complete'; test: LiveTestExecutionPayload; result: LiveTestResultPayload }
  | { type: 'test-error'; test: LiveTestExecutionPayload; error: string }
  | { type: 'screenshot'; data: string }
  | { type: 'session-state'; state: SessionState }
  | { type: 'session-terminated' }
  | { type: 'browser-disconnected' }
  | { type: 'error'; message: string }
  | { type: 'step-busy'; currentStep: string }
  | { type: 'navigate-complete'; url: string | null }
  | { type: 'device-logs'; entries: Array<{ level: string; message: string; timestamp: number }> }
  | { type: 'aria-tree'; tree: string }

export interface SessionState {
  sessionId: string
  platform: 'web' | 'android' | 'ios'
  targetName?: string | null
  status: 'idle' | 'executing' | 'disconnected'
  currentStep: string | null
  currentUrl: string | null
  stepsExecuted: number
  createdAt: number
  interactive: boolean
  terminalError: string | null
}

export interface LiveSessionConfig {
  platform: 'web' | 'android' | 'ios'
  targetName?: string
  llmConfig: LiveSessionLLMConfig
  authFetch?: typeof globalThis.fetch
  agentRules?: string
  envVars?: Record<string, string>
  secretStore?: SecretStore
  secretRedactor?: SecretRedactor
  setupHooks?: string[]
  teardownHooks?: string[]
  resolvedHooks?: Map<string, HookDefinition>
  hookRegistryError?: string
  url?: string
  headless?: boolean
  useDeviceName?: string
  appState?: 'preserve' | 'reset'
  bundleId?: string
  appPackage?: string
  appActivity?: string
  device?: {
    name: string
    platformVersion?: string
    appPath?: string
    browserName?: string
    appPackage?: string
    appActivity?: string
    bundleId?: string
    udid?: string
    avd?: string
    appiumUrl?: string
  }
}
