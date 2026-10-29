// Masked markers are planted where the sink puts them, and every reporter prints them as they are.

import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { MaskFn, QuarantineAppliedEntry } from '@vostride/agent-qa-schema'
import type {
  HookFinishedPayload,
  HookStartedPayload,
  RunEventEnvelope,
  RunEventType,
  RunFinishedPayload,
  RunStartedPayload,
  StepFinalizedPayload,
  StepStartedPayload,
  TestFinishedPayload,
  TestRetryScheduledPayload,
  TestStartedPayload,
  VerdictPayload,
} from '@vostride/agent-qa-schema'

export interface ReporterFixture {
  mask: MaskFn
  stepSecret: string
  hookSecret: string
  summarySecret: string
  envelopes: RunEventEnvelope[]
}

/**
 * Build the canonical fixture. Two member tests: test 0 retries once then passes
 * (proves the testRetryScheduled accumulation reset), test 1 fails with a masked
 * failureSummary. A masked secret rides a failed step's `error`, a hook variable
 * value, and the failed test's `failureSummary`.
 */
export function buildReporterFixture(): ReporterFixture {
  const stepSecret = 'sk-live-STEP-000111222333'
  const hookSecret = 'hook-pw-444555666777'
  const summarySecret = 'sk-live-SUMMARY-888999000'

  const redactor = new SecretRedactor(
    new SecretStore({ STEP_TOKEN: stepSecret, HOOK_PW: hookSecret, SUMMARY_TOKEN: summarySecret }),
  )
  const mask: MaskFn = (text) => redactor.redactString(text)

  let seq = 0
  const runId = 'run-fixture-1'
  const env = <P>(type: RunEventType, payload: P): RunEventEnvelope =>
    ({ seq: seq++, ts: 1_000 + seq, runId, type, payload }) as RunEventEnvelope

  const runStarted: RunStartedPayload = {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { tier: 'suite', key: 'auth-suite' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
    memberTestCount: 2,
  }

  const test0Started: TestStartedPayload = {
    testId: 't0',
    testIndex: 0,
    name: 'Login test',
    filePath: 'tests/login.yaml',
    suiteId: 'suite-1',
    suiteName: 'Auth',
    suiteIndex: 0,
    suiteTotal: 1,
    totalSteps: 2,
  }

  const okStepFinal = (stepIndex: number, durationMs: number): StepFinalizedPayload => ({
    testIndex: 0,
    stepIndex,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'ok' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status: 'passed',
    durationMs,
  })

  const failedStep0: StepFinalizedPayload = {
    testIndex: 0,
    stepIndex: 1,
    cacheStatus: 'miss',
    verifierVerdict: { pass: false, reasoning: 'timeout' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status: 'failed',
    durationMs: 800,
    error: mask(`Timeout waiting for token ${stepSecret}`),
  }

  const hookStarted: HookStartedPayload = {
    hookName: 'seed-db',
    phase: 'setup',
    hookExecutionId: 'h1',
    scope: 'test',
  }

  const hookFinished: HookFinishedPayload = {
    hookName: 'seed-db',
    phase: 'setup',
    hookExecutionId: 'h1',
    scope: 'test',
    status: 'passed',
    durationMs: 300,
    stdout: '',
    stderr: '',
    variables: { TOKEN: mask(hookSecret), REGION: 'us-east-1' },
    kind: 'hook',
  }

  const retry: TestRetryScheduledPayload = {
    testId: 't0',
    testIndex: 0,
    attempt: 1,
    maxAttempts: 2,
    reason: 'flaky',
  }

  const test0Finished: TestFinishedPayload = {
    testId: 't0',
    testIndex: 0,
    outcome: 'passed',
    durationMs: 2_000,
  }

  const test1Started: TestStartedPayload = {
    testId: 't1',
    testIndex: 1,
    name: 'Checkout test',
    filePath: 'tests/checkout.yaml',
    suiteId: 'suite-1',
    suiteName: 'Auth',
    suiteIndex: 0,
    suiteTotal: 1,
    totalSteps: 1,
  }

  const test1FailedStep: StepFinalizedPayload = {
    testIndex: 1,
    stepIndex: 0,
    cacheStatus: 'miss',
    verifierVerdict: { pass: false, reasoning: 'assertion failed' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status: 'failed',
    durationMs: 1_200,
    error: mask('Element not found'),
  }

  const test1Finished: TestFinishedPayload = {
    testId: 't1',
    testIndex: 1,
    outcome: 'failed',
    durationMs: 1_500,
    failureSummary: mask(`Checkout failed near ${summarySecret}`),
  }

  const verdict: VerdictPayload = { verdict: 'failed' }
  const runFinished: RunFinishedPayload = {
    aggregateVerdict: 'failed',
    disposition: 'detached',
    finalSeq: 0,
  }

  const envelopes: RunEventEnvelope[] = [
    env('runStarted', runStarted),
    // test 0 — attempt 1 (one pass, one fail carrying a masked secret)
    env('testStarted', test0Started),
    env('stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Open login page' } satisfies StepStartedPayload),
    env('stepFinalized', okStepFinal(0, 1_200)),
    env('stepStarted', { testIndex: 0, stepIndex: 1, stepText: 'Submit credentials' } satisfies StepStartedPayload),
    env('stepFinalized', failedStep0),
    env('hookStarted', hookStarted),
    env('hookFinished', hookFinished),
    // retry resets test 0's step accumulation
    env('testRetryScheduled', retry),
    env('stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Open login page' } satisfies StepStartedPayload),
    env('stepFinalized', okStepFinal(0, 900)),
    env('testFinished', test0Finished),
    // test 1 — fails, masked failureSummary
    env('testStarted', test1Started),
    env('stepStarted', { testIndex: 1, stepIndex: 0, stepText: 'Add to cart' } satisfies StepStartedPayload),
    env('stepFinalized', test1FailedStep),
    env('testFinished', test1Finished),
    env('verdict', verdict),
    env('runFinished', { ...runFinished, finalSeq: seq }),
  ]

  return { mask, stepSecret, hookSecret, summarySecret, envelopes }
}

// Matched on `(filePath, testName)` as the runner does; `product` is recorded but not matched.
export const QUARANTINED_CHECKOUT: QuarantineAppliedEntry = {
  product: 'shop-web',
  filePath: 'tests/checkout.yaml',
  testName: 'Checkout test',
  expiresAt: '2126-09-04T10:00:00.000Z',
}

/** The same shape addressed at a test this fixture never runs — the negative half of any match pin. */
export const QUARANTINED_ELSEWHERE: QuarantineAppliedEntry = {
  product: 'shop-web',
  filePath: 'tests/settings.yaml',
  testName: 'Settings test',
  expiresAt: '2126-09-04T10:00:00.000Z',
}

/** A simple string-collecting sink for asserting reporter writes. */
export function createCapture(): { write: (chunk: string) => void; output: () => string } {
  const chunks: string[] = []
  return {
    write: (chunk: string) => {
      chunks.push(chunk)
    },
    output: () => chunks.join(''),
  }
}
