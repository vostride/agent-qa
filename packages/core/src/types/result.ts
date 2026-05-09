import type { Action } from './platform.js'

export type StepStatus = 'passed' | 'failed' | 'healed' | 'skipped' | 'cancelled'
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'cancelled'

export interface StepAnnotation {
  clickPoint?: { x: number; y: number }
  boundingBox?: { x: number; y: number; width: number; height: number }
  failureHighlight?: { x: number; y: number; width: number; height: number }
  type: 'click' | 'fill' | 'tap' | 'hover' | 'scroll' | 'swipe' | 'pinch' | 'navigate' | 'other'
  viewport?: { width: number; height: number }
  startPoint?: { x: number; y: number }
  endPoint?: { x: number; y: number }
  direction?: 'up' | 'down' | 'left' | 'right'
  pinchScale?: 'in' | 'out'
}

export interface HealingAttempt {
  action: Action
  observationBefore: string
  observationAfter?: string
  success: boolean
  attemptNumber?: number
  strategy?: string
  reasoning?: string
  confidence?: number
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface SubActionTrace {
  index: number
  observation: string
  reasoning: string
  plannedAction: Action
  result: 'success' | 'failure'
  error?: string
  screenStateBefore: string
  screenStateAfter?: string
  screenContextBefore?: string
  screenContextAfter?: string
  confidence?: number
  verifierReasoning?: string
  cached: boolean
  tokenUsage?: TokenUsage
  phaseDurations?: {
    observe?: number
    plan?: number
    execute?: number
    verify?: number
  }
  screenshotBefore?: Buffer
  screenshotAfter?: Buffer
  annotation?: StepAnnotation
  data?: unknown
}

export interface StepTrace {
  observation: string
  reasoning: string
  plannedAction: Action
  result: 'success' | 'failure'
  error?: string
  screenStateBefore: string
  screenStateAfter?: string
  screenContextBefore?: string
  screenContextAfter?: string
  confidence?: number
  verifierReasoning?: string
  tokenUsage?: TokenUsage
  phaseDurations?: {
    observe?: number
    plan?: number
    execute?: number
    verify?: number
    heal?: number
  }
  subActions?: SubActionTrace[]
}

export interface StepPhaseEvent {
  phase: 'observe' | 'plan' | 'execute' | 'verify' | 'heal'
  subActionIndex?: number
  phaseOrdinal?: number
  text?: string
  confidence?: number
  action?: unknown
  success?: boolean
  duration?: number
}

export interface AccessibilityViolation {
  ruleId: string
  impact: 'minor' | 'moderate' | 'serious' | 'critical'
  description: string
  help: string
  helpUrl: string
  nodes: Array<{
    html: string
    target: string[]
  }>
}

export interface ConsoleLogEntry {
  level: string
  text: string
  location?: { url: string; lineNumber: number; columnNumber: number }
  timestamp: number
}

export interface NetworkLogEntry {
  url: string
  method: string
  status: number
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  body?: string
  requestBody?: string
  startTime: number
  endTime: number
  timing?: Record<string, number>
}

export interface StepResult {
  id?: string
  name: string
  status: StepStatus
  duration: number
  action?: Action
  observation?: string
  error?: string
  screenshot?: Buffer
  screenshotBefore?: Buffer
  healingAttempts?: HealingAttempt[]
  trace?: StepTrace
  retryCount?: number
  capturedVariables?: Record<string, string>
  annotation?: StepAnnotation
  healingScreenshots?: Buffer[]
  accessibilityViolations?: AccessibilityViolation[]
  consoleLogs?: ConsoleLogEntry[]
  networkLogs?: NetworkLogEntry[]
  variableSnapshot?: Record<string, { value: string; source: string }>
  originalStepName?: string
}

export interface TestResult {
  runId?: string
  name: string
  filePath: string
  status: TestStatus
  steps: StepResult[]
  duration: number
  metadata?: Record<string, unknown>
  retryCount?: number
  videoPath?: string
  failureSummary?: string
}
