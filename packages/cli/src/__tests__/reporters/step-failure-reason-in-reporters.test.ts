// an unproven step's reason is the step's error, and it reaches
// the JUnit failure message and the console reporter's failed-step line verbatim.

import { describe, expect, it } from 'vitest'

import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  RunEventEnvelope,
  RunEventType,
  StepFinalizedPayload,
  StepStartedPayload,
  TestFinishedPayload,
  TestStartedPayload,
} from '@vostride/agent-qa-schema'

import { createConsoleReporter } from '../../reporters/console-reporter.js'
import { createJunitReporter } from '../../reporters/junit-reporter.js'
import { createCapture } from './fixtures.js'

const UNPROVEN_ERROR =
  'Step failed: The draft was not saved — Unverified: "the setting is saved" (no re-read after reload)'

function envelopes(): RunEventEnvelope[] {
  let seq = 0
  const env = <P>(type: RunEventType, payload: P): RunEventEnvelope =>
    ({ seq: seq++, ts: 1_000 + seq, runId: 'run-439-reason', type, payload }) as RunEventEnvelope
  const started: TestStartedPayload = {
    testId: 't0',
    testIndex: 0,
    name: 'Settings test',
    filePath: 'tests/settings.yaml',
    suiteId: 'suite-1',
    suiteName: 'Settings',
    suiteIndex: 0,
    suiteTotal: 1,
    totalSteps: 1,
  }
  const finalized: StepFinalizedPayload = {
    testIndex: 0,
    stepIndex: 0,
    cacheStatus: 'miss',
    verifierVerdict: { pass: false, reasoning: 'Unverified: "the setting is saved"' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status: 'failed',
    durationMs: 900,
    error: UNPROVEN_ERROR,
  }
  const finished: TestFinishedPayload = {
    testId: 't0',
    testIndex: 0,
    outcome: 'failed',
    durationMs: 1_000,
  }
  return [
    env('runStarted', {
      busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
      scope: { tier: 'suite', key: 'settings-suite' },
      executionContext: 'local-headless',
      buildOrdinal: 1,
      configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
      memberTestCount: 1,
    }),
    env('testStarted', started),
    env('stepStarted', {
      testIndex: 0,
      stepIndex: 0,
      stepText: 'Save the setting',
    } satisfies StepStartedPayload),
    env('stepFinalized', finalized),
    env('testFinished', finished),
    env('verdict', { verdict: 'failed' }),
    env('runFinished', { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: seq }),
  ]
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

describe('the step failure reason in the reporters', () => {
  it('the reason text reaches JUnit and the console verbatim', async () => {
    let xml = ''
    const junit = createJunitReporter({
      outputPath: 'out/junit.xml',
      write: async (_path: string, content: string) => {
        xml = content
      },
    })
    for (const envelope of envelopes()) junit.handler(envelope)
    await junit.flush()
    const message = /<failure message="([^"]*)"/.exec(xml)?.[1]
    expect(message).toBeDefined()
    expect(unescapeXml(message ?? '')).toBe(UNPROVEN_ERROR)

    const capture = createCapture()
    const reporter = createConsoleReporter({
      plain: true,
      colorize: false,
      verbose: true,
      write: capture.write,
      isTTY: false,
    })
    for (const envelope of envelopes()) reporter.handler(envelope)
    expect(capture.output()).toContain(`Error: ${UNPROVEN_ERROR}`)
  })
})
