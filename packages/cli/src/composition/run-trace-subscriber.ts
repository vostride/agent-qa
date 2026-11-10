// One run's bus events become coarse spans with explicit parents, and the run state an error
// carries. A span name is a fixed word and an attribute is an id, an index or a closed value, so no
// test name, step text, path or URL is ever set. Nothing here may fail a run.

import {
  ANALYTICS_REMOTE_PLUGINS,
  ANALYTICS_RUNNERS,
  analyticsRunId,
} from '@vostride/agent-qa-analytics'
import { ACTION_WIRE_SCHEMAS_BY_TYPE } from '@vostride/agent-qa-schema'
import type { Platform, RunEventEnvelope } from '@vostride/agent-qa-schema'

import type {
  ErrorReporter,
  ReportRunState,
  ReportSpan,
  ReportSpanInput,
  ReportSpanOutcome,
} from './error-reporting.js'

const ADAPTERS = {
  web: 'playwright',
  android: 'uiautomator2',
  ios: 'xcuitest',
} as const satisfies Record<Platform, string>

export function adapterFor(platform: Platform): (typeof ADAPTERS)[Platform] {
  return ADAPTERS[platform]
}

// Every open step span in the process, so a model call finds the step it belongs to.
const openSteps = new Map<string, ReportSpan>()

function stepKey(runId: string, testIndex: number, stepIndex: number): string {
  return JSON.stringify([runId, testIndex, stepIndex])
}

export interface RunTraceSubscriberInput {
  readonly reporter: ErrorReporter
  readonly runner?: string
  readonly remotePlugins?: readonly string[]
  readonly platforms?: readonly Platform[]
}

export interface RunTraceSubscriber {
  handler(envelope: RunEventEnvelope): void
  flush(): Promise<void>
}

interface PayloadView {
  readonly testIndex?: unknown
  readonly stepIndex?: unknown
  readonly outcome?: unknown
  readonly aggregateVerdict?: unknown
  readonly plannedAction?: { readonly type?: unknown }
}

interface OpenStep {
  readonly key: string
  readonly testIndex: number
  readonly stepIndex: number
  readonly span: ReportSpan
}

// Reading a property off a number does not throw, so a malformed payload is refused here.
function readIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function actionKind(value: unknown): string | undefined {
  return typeof value === 'string' && Object.hasOwn(ACTION_WIRE_SCHEMAS_BY_TYPE, value)
    ? value
    : undefined
}

// A span its own event ends is ok, a failed verdict included. One that another event cuts off
// broke off on the way, unless that event says the work was cancelled.
function cutOffOutcome(verdict: unknown): ReportSpanOutcome {
  return verdict === 'cancelled' ? 'ok' : 'error'
}

export function createRunTraceSubscriber(input: RunTraceSubscriberInput): RunTraceSubscriber {
  const { reporter } = input
  const runner = ANALYTICS_RUNNERS.find((candidate) => candidate === input.runner) ?? 'unknown'
  const pluginIds = (input.remotePlugins ?? []).map(
    (value) => ANALYTICS_REMOTE_PLUGINS.find((candidate) => candidate === value) ?? 'third_party',
  )
  const plugins = [...new Set(pluginIds)]
  const platforms = [...new Set(input.platforms ?? [])]
  const first = platforms[0]
  const place = first === undefined ? {} : { platform: first, adapter: adapterFor(first) }

  let runId: string | undefined
  let stateId: string | undefined
  let run: ReportSpan | undefined
  let finished = false
  let state: ReportRunState | undefined
  let stateStep: { readonly testIndex: number; readonly stepIndex: number } | undefined
  const tests = new Map<number, ReportSpan>()
  const steps = new Map<string, OpenStep>()

  function setState(next: ReportRunState | undefined): void {
    state = next
    if (stateId !== undefined) reporter.setRunState(stateId, next)
  }

  // An agent-qa run command is one trace; a long-lived host starts each run in its own.
  function lineage(): Pick<ReportSpanInput, 'parent' | 'newTrace'> {
    if (reporter.command !== 'run') return { newTrace: true }
    const parent = reporter.commandSpan
    return parent === undefined ? {} : { parent }
  }

  function beginRun(envelope: RunEventEnvelope): void {
    if (run !== undefined || typeof envelope.runId !== 'string') return
    runId = envelope.runId
    stateId = analyticsRunId(envelope.runId)
    run = reporter.startSpan({
      op: 'agent_qa.run',
      name: 'run',
      attributes: {
        ...(stateId === undefined ? {} : { 'agent_qa.run_id': stateId }),
        'agent_qa.runner': runner,
        ...(platforms.length === 0 ? {} : { 'agent_qa.platforms': platforms }),
        ...(plugins.length === 0 ? {} : { 'agent_qa.plugins': plugins }),
      },
      ...lineage(),
    })
    setState({ runner, ...place })
  }

  function beginTest(parent: ReportSpan, testIndex: number): void {
    if (tests.has(testIndex)) return
    const span = reporter.startSpan({
      op: 'agent_qa.test',
      name: 'test',
      attributes: { 'agent_qa.test_index': testIndex },
      parent,
    })
    tests.set(testIndex, span)
  }

  function endTest(testIndex: number, outcome: ReportSpanOutcome): void {
    const span = tests.get(testIndex)
    tests.delete(testIndex)
    span?.end(outcome)
  }

  function beginStep(parent: ReportSpan, owner: string, testIndex: number, stepIndex: number) {
    const key = stepKey(owner, testIndex, stepIndex)
    if (steps.has(key)) return
    const span = reporter.startSpan({
      op: 'agent_qa.step',
      name: 'step',
      attributes: { 'agent_qa.step_index': stepIndex },
      parent: tests.get(testIndex) ?? parent,
    })
    steps.set(key, { key, testIndex, stepIndex, span })
    openSteps.set(key, span)
    stateStep = { testIndex, stepIndex }
    setState({ runner, ...place, step: stepIndex })
  }

  function endStep(step: OpenStep, outcome: ReportSpanOutcome): void {
    steps.delete(step.key)
    openSteps.delete(step.key)
    step.span.end(outcome)
  }

  function endStepsOf(testIndex: number, outcome: ReportSpanOutcome): void {
    for (const step of [...steps.values()]) {
      if (step.testIndex === testIndex) endStep(step, outcome)
    }
  }

  function recordAction(owner: string, testIndex: number, stepIndex: number, action: string) {
    const step = steps.get(stepKey(owner, testIndex, stepIndex))
    if (step === undefined) return
    step.span.setAttributes({ 'agent_qa.action': action })
    if (stateStep?.testIndex === testIndex && stateStep.stepIndex === stepIndex && state) {
      setState({ ...state, action })
    }
  }

  function finish(span: ReportSpan, cutOff: ReportSpanOutcome, outcome: ReportSpanOutcome) {
    finished = true
    for (const step of [...steps.values()]) endStep(step, cutOff)
    for (const testIndex of [...tests.keys()]) endTest(testIndex, cutOff)
    span.end(outcome)
    setState(undefined)
  }

  function dispatch(envelope: RunEventEnvelope): void {
    if (envelope.type === 'runStarted') {
      beginRun(envelope)
      return
    }
    if (run === undefined || finished || runId === undefined || envelope.runId !== runId) return
    const payload = envelope.payload as PayloadView
    const testIndex = readIndex(payload.testIndex)
    const stepIndex = readIndex(payload.stepIndex)
    switch (envelope.type) {
      case 'testStarted':
        if (testIndex !== undefined) beginTest(run, testIndex)
        break
      case 'stepStarted':
        if (testIndex !== undefined && stepIndex !== undefined) {
          beginStep(run, runId, testIndex, stepIndex)
        }
        break
      case 'subActionRecorded': {
        const action = actionKind(payload.plannedAction?.type)
        if (testIndex !== undefined && stepIndex !== undefined && action !== undefined) {
          recordAction(runId, testIndex, stepIndex, action)
        }
        break
      }
      case 'stepFinalized': {
        if (testIndex === undefined || stepIndex === undefined) break
        const step = steps.get(stepKey(runId, testIndex, stepIndex))
        if (step !== undefined) endStep(step, 'ok')
        break
      }
      // The attempt ends here; the next one opens its own test span, since no testStarted follows.
      case 'testRetryScheduled':
        if (testIndex !== undefined && tests.has(testIndex)) {
          endStepsOf(testIndex, 'error')
          endTest(testIndex, 'ok')
          beginTest(run, testIndex)
        }
        break
      case 'testFinished':
        if (testIndex !== undefined) {
          endStepsOf(testIndex, cutOffOutcome(payload.outcome))
          endTest(testIndex, 'ok')
        }
        break
      case 'runFinished':
        finish(run, cutOffOutcome(payload.aggregateVerdict), 'ok')
        break
      default:
        break
    }
  }

  return {
    handler(envelope: RunEventEnvelope): void {
      try {
        dispatch(envelope)
      } catch {
        // A malformed envelope never breaks a run.
      }
    },
    // A run that never reached runFinished broke off, so what it left open ends, state included.
    async flush(): Promise<void> {
      try {
        if (run !== undefined && !finished) finish(run, 'error', 'error')
      } catch {
        // Closing a trace never fails the run it traced.
      }
    },
  }
}
