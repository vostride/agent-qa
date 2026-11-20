import { colorsFor, printLogLine } from '@vostride/agent-qa-core/run-text-output'
import type { LogColors } from '@vostride/agent-qa-core/run-text-output'
import type {
  RunEventEnvelope,
  RunFinishedPayload,
  RunStartedPayload,
  StepFinalizedPayload,
  TestFinishedPayload,
  TestRetryScheduledPayload,
  TestStartedPayload,
} from '@vostride/agent-qa-schema'

import { humanDuration } from './console-reporter.js'
import { shortRunId } from './short-run-id.js'

export interface RunLineReporterOptions {
  readonly platforms?: readonly string[]
  // Defaults to a tagged `run` line on stdout.
  readonly print?: (message: string) => void
  // Defaults to stdout's colours; colours the result's icon only.
  readonly colors?: LogColors
}

export interface RunLineReporterHandle {
  handler: (envelope: RunEventEnvelope) => void
}

interface FailedStep {
  readonly number: number
  readonly error?: string
}

interface TestFailure {
  readonly name: string
  readonly step?: FailedStep
  readonly failureSummary?: string
}

function testCount(count: number): string {
  return `${count} ${count === 1 ? 'test' : 'tests'}`
}

// Every text taken from a run is printed as its event carries it, masked at its source.
export function createRunLineReporter(options: RunLineReporterOptions = {}): RunLineReporterHandle {
  const print = options.print ?? ((message: string) => printLogLine({ tag: 'run', message }))
  const colors = options.colors ?? colorsFor(process.stdout)
  const platforms = options.platforms ?? []

  let startedAt: number | undefined
  let memberTestCount = 0
  let label: string | undefined
  let severalTests = false
  let finished = false
  let testsFinished = 0
  let testsPassed = 0
  const testNames = new Map<number, string>()
  const failedSteps = new Map<number, FailedStep>()
  const failures: TestFailure[] = []

  function onTestStarted(envelope: RunEventEnvelope, payload: TestStartedPayload): void {
    testNames.set(payload.testIndex, payload.name)
    failedSteps.delete(payload.testIndex)
    if (label !== undefined) return
    severalTests = payload.suiteName !== undefined || memberTestCount > 1
    label = payload.suiteName ?? (memberTestCount > 1 ? testCount(memberTestCount) : payload.name)
    const parts = [label]
    if (payload.suiteName !== undefined) parts.push(testCount(memberTestCount))
    if (platforms.length > 0) parts.push(platforms.join(', '))
    parts.push(shortRunId(envelope.runId))
    print(`▶ ${parts.join(' · ')}`)
  }

  function onStepFinalized(payload: StepFinalizedPayload): void {
    if (payload.status !== 'failed' || failedSteps.has(payload.testIndex)) return
    failedSteps.set(payload.testIndex, {
      number: payload.stepIndex + 1,
      ...(payload.error === undefined ? {} : { error: payload.error }),
    })
  }

  function onTestFinished(payload: TestFinishedPayload): void {
    testsFinished++
    const outcome = payload.outcome
    if (outcome === 'passed' || outcome === 'healed') testsPassed++
    if (outcome !== 'failed' && outcome !== 'timeout') return
    const step = failedSteps.get(payload.testIndex)
    failures.push({
      name: testNames.get(payload.testIndex) ?? payload.name ?? `Test ${payload.testIndex + 1}`,
      ...(step === undefined ? {} : { step }),
      ...(payload.failureSummary === undefined ? {} : { failureSummary: payload.failureSummary }),
    })
  }

  function failureText(failure: TestFailure): string | undefined {
    if (failure.step !== undefined) {
      const { number, error } = failure.step
      return error === undefined ? `step ${number}` : `step ${number}: ${error}`
    }
    const firstLine = failure.failureSummary?.split('\n')[0]
    return firstLine === '' ? undefined : firstLine
  }

  function outcomeWords(verdict: RunFinishedPayload['aggregateVerdict']): string {
    if (!severalTests) return verdict
    const total = Math.max(memberTestCount, testsFinished)
    if (verdict === 'passed' || verdict === 'healed') {
      return testsPassed === total ? `${total} passed` : `${testsPassed} of ${total} passed`
    }
    if (verdict === 'failed' && failures.length > 0) return `${failures.length} of ${total} failed`
    return verdict
  }

  function onRunFinished(envelope: RunEventEnvelope, payload: RunFinishedPayload): void {
    if (finished) return
    finished = true
    if (label === undefined) {
      severalTests = memberTestCount !== 1
      label = severalTests ? testCount(memberTestCount) : (failures[0]?.name ?? testCount(1))
    }
    const verdict = payload.aggregateVerdict
    const passed = verdict === 'passed' || verdict === 'healed'
    const icon = passed
      ? colors.green('✓')
      : verdict === 'cancelled'
        ? colors.yellow('⊘')
        : colors.red('✗')
    const duration = humanDuration(envelope.ts - (startedAt ?? envelope.ts))
    const result = `${icon} ${label} · ${outcomeWords(verdict)} · ${duration}`
    const failure = passed || verdict === 'cancelled' ? undefined : failures[0]
    if (failure === undefined) {
      print(result)
      return
    }
    const text = failureText(failure)
    const detail = severalTests
      ? text === undefined
        ? failure.name
        : `${failure.name} · ${text}`
      : text
    print(detail === undefined ? result : `${result}\n${detail}`)
  }

  function handler(envelope: RunEventEnvelope): void {
    // The bus detaches a throwing subscriber, so one malformed envelope must not end the lines.
    try {
      switch (envelope.type) {
        case 'runStarted':
          startedAt = envelope.ts
          memberTestCount = (envelope.payload as RunStartedPayload).memberTestCount
          break
        case 'testStarted':
          onTestStarted(envelope, envelope.payload as TestStartedPayload)
          break
        case 'stepFinalized':
          onStepFinalized(envelope.payload as StepFinalizedPayload)
          break
        case 'testRetryScheduled':
          failedSteps.delete((envelope.payload as TestRetryScheduledPayload).testIndex)
          break
        case 'testFinished':
          onTestFinished(envelope.payload as TestFinishedPayload)
          break
        case 'runFinished':
          onRunFinished(envelope, envelope.payload as RunFinishedPayload)
          break
        default:
          break
      }
    } catch {
      // swallow: the reporter stays attached for the rest of the run
    }
  }

  return { handler }
}
