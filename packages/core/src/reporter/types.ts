import type { TestDefinition } from '../types/test.js'
import type { StepPhaseEvent, StepResult, TestResult } from '../types/result.js'
import type { SuiteDefinition } from '../suite/types.js'
import type { RunArtifactReporterContext } from '../artifacts/run-artifact.js'

export interface RunSummary {
  results: TestResult[]
  duration: number
  passed: number
  failed: number
  skipped: number
}

export interface SuiteSummary {
  runId?: string
  name: string
  status: 'passed' | 'failed' | 'cancelled'
  tests: TestResult[]
  duration: number
  passed: number
  failed: number
  skipped: number
}

export interface HookEvent {
  hookId?: string
  hookName: string
  phase: 'setup' | 'teardown' | 'inline'
  hookExecutionId: string
  runId?: string
  stepId?: string
}

export interface StepEventContext {
  runId?: string
  parentRunId?: string | null
  suiteIndex?: number
  suiteTotal?: number
  testIndex?: number
  stepIndex?: number
  stepId?: string
}

export interface HookResultEvent extends HookEvent {
  status: 'passed' | 'failed'
  duration: number
  stdout: string
  stderr: string
  variables: Record<string, string>
  error?: string
  type?: 'hook' | 'appium-script' | 'runjs'
}

export interface Reporter {
  onSuiteStart?(suite: SuiteDefinition, context?: RunArtifactReporterContext): void | Promise<void>
  onSuiteEnd?(summary: SuiteSummary): void | Promise<void>
  onRunStart?(tests: TestDefinition[]): void | Promise<void>
  onTestStart?(test: TestDefinition, filePath: string, context?: RunArtifactReporterContext): void | Promise<void>
  onStepStart?(step: string, testName: string, context?: StepEventContext): void | Promise<void>
  onStepEnd?(result: StepResult, testName: string, context?: StepEventContext): void | Promise<void>
  onTestEnd?(result: TestResult): void | Promise<void>
  onRunEnd?(summary: RunSummary): void | Promise<void>
  onStepPhase?(phase: StepPhaseEvent, stepName: string, testName: string, context?: StepEventContext): void | Promise<void>
  onHookStart?(event: HookEvent): void | Promise<void>
  onHookEnd?(event: HookResultEvent): void | Promise<void>
}

export type ReporterEvent =
  | { type: 'suite-start'; suite: SuiteDefinition; context?: RunArtifactReporterContext }
  | { type: 'suite-end'; summary: SuiteSummary }
  | { type: 'run-start'; tests: TestDefinition[] }
  | { type: 'test-start'; test: TestDefinition; filePath: string; context?: RunArtifactReporterContext }
  | { type: 'step-start'; step: string; testName: string; context?: StepEventContext }
  | { type: 'step-end'; result: StepResult; testName: string; context?: StepEventContext }
  | { type: 'test-end'; result: TestResult }
  | { type: 'run-end'; summary: RunSummary }
  | { type: 'step-phase'; phase: StepPhaseEvent; stepName: string; testName: string; context?: StepEventContext }
  | { type: 'hook-start'; event: HookEvent }
  | { type: 'hook-end'; event: HookResultEvent }

export class FatalReporterError extends Error {
  readonly fatal = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FatalReporterError'
  }
}

export class MultiReporter implements Reporter {
  private reporters: Reporter[]

  constructor(reporters: Reporter[]) {
    this.reporters = reporters
  }

  private handleReporterError(error: unknown): void {
    if (
      error instanceof FatalReporterError
      || (typeof error === 'object' && error !== null && (error as { fatal?: unknown }).fatal === true)
    ) {
      throw error
    }
  }

  async onSuiteStart(suite: SuiteDefinition, context?: RunArtifactReporterContext): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        if (context === undefined) {
          await reporter.onSuiteStart?.(suite)
        } else {
          await reporter.onSuiteStart?.(suite, context)
        }
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onSuiteEnd(summary: SuiteSummary): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        await reporter.onSuiteEnd?.(summary)
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onRunStart(tests: TestDefinition[]): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        await reporter.onRunStart?.(tests)
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onTestStart(test: TestDefinition, filePath: string, context?: RunArtifactReporterContext): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        if (context === undefined) {
          await reporter.onTestStart?.(test, filePath)
        } else {
          await reporter.onTestStart?.(test, filePath, context)
        }
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onStepStart(step: string, testName: string, context?: StepEventContext): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        if (context === undefined) {
          await reporter.onStepStart?.(step, testName)
        } else {
          await reporter.onStepStart?.(step, testName, context)
        }
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onStepEnd(result: StepResult, testName: string, context?: StepEventContext): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        if (context === undefined) {
          await reporter.onStepEnd?.(result, testName)
        } else {
          await reporter.onStepEnd?.(result, testName, context)
        }
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onTestEnd(result: TestResult): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        await reporter.onTestEnd?.(result)
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onRunEnd(summary: RunSummary): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        await reporter.onRunEnd?.(summary)
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onStepPhase(phase: StepPhaseEvent, stepName: string, testName: string, context?: StepEventContext): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        if (context === undefined) {
          await reporter.onStepPhase?.(phase, stepName, testName)
        } else {
          await reporter.onStepPhase?.(phase, stepName, testName, context)
        }
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onHookStart(event: HookEvent): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        await reporter.onHookStart?.(event)
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }

  async onHookEnd(event: HookResultEvent): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        await reporter.onHookEnd?.(event)
      } catch (error) {
        this.handleReporterError(error)
      }
    }
  }
}
