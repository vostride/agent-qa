import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

import { createWireReporter } from '../../reporters/wire-reporter.js'
import { buildReporterFixture, createCapture } from './fixtures.js'

const PREFIX = 'AGENT_QA_EVENT:'

function stepEnvelope(stepText: string): RunEventEnvelope {
  return {
    seq: 0,
    ts: 1_000,
    runId: 'run-wire-actions',
    type: 'stepStarted',
    payload: { testIndex: 0, stepIndex: 0, stepText },
  } as RunEventEnvelope
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createWireReporter', () => {
  it('with AGENT_QA_LIVE_EVENTS=true prints one verbatim envelope line each', () => {
    vi.stubEnv('AGENT_QA_LIVE_EVENTS', 'true')
    const fixture = buildReporterFixture()
    const capture = createCapture()
    const reporter = createWireReporter({ write: capture.write })
    for (const envelope of fixture.envelopes) reporter.handler(envelope)

    const lines = capture.output().split('\n').filter(Boolean)
    expect(lines.length).toBe(fixture.envelopes.length)
    lines.forEach((line, index) => {
      expect(line.startsWith(PREFIX)).toBe(true)
      // round-trip: the envelope is emitted VERBATIM after the 15-char prefix
      expect(JSON.parse(line.slice(PREFIX.length))).toEqual(fixture.envelopes[index])
    })
  })

  it('stays MASKED — placeholders travel, originals never do', () => {
    vi.stubEnv('AGENT_QA_LIVE_EVENTS', 'true')
    const fixture = buildReporterFixture()
    const capture = createCapture()
    const reporter = createWireReporter({ write: capture.write })
    for (const envelope of fixture.envelopes) reporter.handler(envelope)
    const output = capture.output()
    expect(output).toMatch(/\[secret:\w+\]/)
    expect(output).not.toContain(fixture.stepSecret)
    expect(output).not.toContain(fixture.hookSecret)
    expect(output).not.toContain(fixture.summarySecret)
  })

  it('with the gate unset, nothing prints', () => {
    vi.stubEnv('AGENT_QA_LIVE_EVENTS', '')
    const fixture = buildReporterFixture()
    const capture = createCapture()
    const reporter = createWireReporter({ write: capture.write })
    for (const envelope of fixture.envelopes) reporter.handler(envelope)
    expect(capture.output()).toBe('')
  })

  it('escapes every # under GitHub Actions and parses back to the same envelope', () => {
    vi.stubEnv('AGENT_QA_LIVE_EVENTS', 'true')
    const envelope = stepEnvelope('##[error]x')
    const capture = createCapture()
    createWireReporter({ write: capture.write, env: { GITHUB_ACTIONS: 'true' } }).handler(envelope)
    const line = capture.output()
    expect(line.startsWith(PREFIX)).toBe(true)
    expect(line.endsWith('\n')).toBe(true)
    expect(line).not.toContain('#')
    expect(JSON.parse(line.slice(PREFIX.length))).toEqual(envelope)
  })

  it('prints the plain serialized envelope off GitHub Actions', () => {
    vi.stubEnv('AGENT_QA_LIVE_EVENTS', 'true')
    const envelope = stepEnvelope('##[error]x')
    const capture = createCapture()
    createWireReporter({ write: capture.write, env: {} }).handler(envelope)
    expect(capture.output()).toBe(`${PREFIX}${JSON.stringify(envelope)}\n`)
  })

  it('the prefix is exactly 15 characters (slice(15) round-trip contract)', () => {
    expect(PREFIX.length).toBe(15)
  })
})
