// The re-homed identity store and run-completion subscriber (Phase 398 plan 06 task 3, D-17).
//
// WHAT THESE CELLS ARE GUARDING. Both modules were MOVED out of `packages/core/src/analytics/`
// rather than re-invented, and a move has exactly two ways to go wrong that a green test suite
// would otherwise hide:
//
//   1. The id scheme drifts. If the re-homed generator mints a different SHAPE of id, every
//      existing install silently becomes a new person on the next run — the analytics equivalent
//      of dropping the table. So the scheme is asserted on a PRODUCED id (parsed back through
//      `id-agent`, the same parser the ids package uses) rather than restated as a literal, AND
//      against a frozen literal of the carried constants. Plan 06 additionally cross-checked core's
//      surviving copy of the scheme; 398-11 deleted that copy, so that cell is gone — see the note
//      on the scheme cell below for why it was removed rather than left standing.
//   2. The record widens. The stored record is two keys, and prohibition P3 says it stays two
//      keys — no hostname, no username, no cwd, no repo, no path. The key-set pin below reads the
//      record BACK OFF DISK and parses it, because the object handed to the writer is not the
//      thing an attacker or an audit sees; the bytes are.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateRunId, generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope, RunEventPayload, RunEventType } from '@vostride/agent-qa-schema'
import { parse } from 'id-agent'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentQaAnalyticsEventSchema, type AgentQaAnalyticsEvent } from '../events.js'
import {
  ANALYTICS_USER_ID_PREFIX,
  ANALYTICS_USER_ID_WORDS,
  generateAnalyticsUserId,
  getAnalyticsIdentityPath,
  readAnalyticsIdentity,
  resolveAnalyticsAgentProduct,
  resolveAnalyticsIdentity,
} from '../identity.js'
import { createAnalyticsPort } from '../port.js'
import type { AnalyticsCapturePayload, AnalyticsTransport } from '../port.js'
import { createAnalyticsRunSubscriber } from '../run-subscriber.js'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDataHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-qa-analytics-identity-'))
  roots.push(root)
  return root
}

describe('the re-homed distinct-id scheme', () => {
  it('mints the id shape the deleted core module minted — prefix and word count, frozen', () => {
    // WHERE 'u' AND 10 COME FROM, AND WHY THEY ARE WRITTEN OUT HERE.
    //
    // Plan 06 anchored this claim TWICE: on a produced id, and on the literal
    // `idAgent({ prefix: 'u', words: 10 })` still spelled in `packages/core/src/analytics/
    // identity.ts` — the definition this module was carried from. Plan 11 deleted that file, and
    // the second cell was guarded by `existsSync`, so it did not fail when its subject vanished:
    // it RETURNED EARLY AND REPORTED A PASS. Measured before the deletion landed, the file reports
    // `Tests 18 passed (18)` both with core's `identity.ts` present and with it absent — a cell
    // asserting nothing, indistinguishable from a cell asserting something.
    //
    // So it was deleted rather than left standing, and the claim is re-anchored here on a FROZEN
    // LITERAL: 'u' and 10 are the exact values core spelled at the moment of its deletion, copied
    // into this file so that the scheme now has an origin written down instead of a second live
    // definition to agree with. The pair of claims below still catches drift in either direction —
    // a changed constant reds the frozen literal, a generator that stops reading the constants reds
    // the produced id.
    const parsed = parse(generateAnalyticsUserId())

    expect(parsed?.prefix).toBe('u')
    expect(parsed?.wordCount).toBe(10)
    expect(ANALYTICS_USER_ID_PREFIX).toBe('u')
    expect(ANALYTICS_USER_ID_WORDS).toBe(10)
  })

  it('resolves the store path by the carried contract: XDG_DATA_HOME override, else ~/.agent-qa', () => {
    expect(getAnalyticsIdentityPath({ XDG_DATA_HOME: '/xdg' }, '/home/someone')).toBe(
      join('/xdg', 'agent-qa', 'analytics.json'),
    )
    expect(getAnalyticsIdentityPath({}, '/home/someone')).toBe(
      join('/home/someone', '.agent-qa', 'analytics.json'),
    )
  })
})

describe('the identity store round-trip', () => {
  let dataHome: string
  let identityPath: string

  beforeEach(async () => {
    dataHome = await tempDataHome()
    identityPath = join(dataHome, 'agent-qa', 'analytics.json')
  })

  it('mints an id once and returns the SAME id on every later load', async () => {
    const env = { XDG_DATA_HOME: dataHome }

    const first = await resolveAnalyticsIdentity({ env })
    const second = await resolveAnalyticsIdentity({ env })
    const third = await resolveAnalyticsIdentity({ env })

    expect(first.distinctId).toMatch(/^u_/u)
    expect(second.distinctId).toBe(first.distinctId)
    expect(third.distinctId).toBe(first.distinctId)
    expect(first.runtimeContext).toBe('user')
    expect(existsSync(identityPath)).toBe(true)
  })

  it('stores EXACTLY the carried pair of keys — read back off disk, not off the input object', async () => {
    await resolveAnalyticsIdentity({ env: { XDG_DATA_HOME: dataHome } })

    const record = JSON.parse(await readFile(identityPath, 'utf8')) as Record<string, unknown>

    // Prohibition P3 as an exact-set claim: anything a later change adds — a hostname, a username,
    // a cwd, a repo slug, a path — lands here as an unexpected key and reds, which is the point.
    expect(Object.keys(record).sort()).toEqual(['distinctId', 'is_internal'])
    expect(typeof record.distinctId).toBe('string')
    expect(record.is_internal).toBe(false)
  })

  it('reads an existing store written in the carried format unchanged', async () => {
    const existingId = generateAnalyticsUserId()
    await mkdir(dirname(identityPath), { recursive: true })
    await writeFile(
      identityPath,
      JSON.stringify({ distinctId: existingId, is_internal: true }, null, 2),
      { mode: 0o600 },
    )

    expect(await readAnalyticsIdentity(identityPath)).toEqual({
      distinctId: existingId,
      is_internal: true,
    })
  })

  it('refuses a record whose id is not the carried shape rather than adopting it', async () => {
    await mkdir(dirname(identityPath), { recursive: true })
    await writeFile(identityPath, JSON.stringify({ distinctId: 'u_not-the-scheme' }), 'utf8')

    expect(await readAnalyticsIdentity(identityPath)).toBeNull()

    const resolved = await resolveAnalyticsIdentity({ env: { XDG_DATA_HOME: dataHome } })
    expect(resolved.distinctId).not.toBe('u_not-the-scheme')
    expect(parse(resolved.distinctId)?.wordCount).toBe(ANALYTICS_USER_ID_WORDS)
  })

  it('writes the store owner-only', async () => {
    await resolveAnalyticsIdentity({ env: { XDG_DATA_HOME: dataHome } })

    expect((await stat(identityPath)).mode & 0o777).toBe(0o600)
  })

  it('detects the agent products the carried table names', () => {
    expect(resolveAnalyticsAgentProduct({ CURSOR_AGENT: '1' })).toBe('cursor')
    expect(resolveAnalyticsAgentProduct({ AGENT: 'goose' })).toBe('goose')
    expect(resolveAnalyticsAgentProduct({ AGENT: 'amp' })).toBe('amp')
    expect(resolveAnalyticsAgentProduct({ AGENT: 'something-new' })).toBe('unknown')
    expect(resolveAnalyticsAgentProduct({ AGENT: '' })).toBeUndefined()
    expect(resolveAnalyticsAgentProduct({})).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------------------------
// The re-homed run subscriber
// -----------------------------------------------------------------------------------------------

interface RecordingTransport extends AnalyticsTransport {
  readonly payloads: AnalyticsCapturePayload[]
  flushCount(): number
}

function recordingTransport(): RecordingTransport {
  const payloads: AnalyticsCapturePayload[] = []
  let flushes = 0
  return {
    payloads,
    flushCount: () => flushes,
    capture(payload) {
      payloads.push(payload)
    },
    flush() {
      flushes += 1
    },
    shutdown() {},
  }
}

function eventsOf(transport: RecordingTransport): AgentQaAnalyticsEvent[] {
  return transport.payloads.map((payload) => payload.event as AgentQaAnalyticsEvent)
}

describe('the re-homed run subscriber', () => {
  const runId = generateRunId()
  const testId = generateTestId()
  const suiteId = generateSuiteId()

  let seq = 0

  function envelope(type: RunEventType, payload: unknown): RunEventEnvelope {
    seq += 1
    return { seq, ts: 1_700_000_000_000 + seq, runId, type, payload: payload as RunEventPayload }
  }

  beforeEach(() => {
    seq = 0
  })

  function harness() {
    const transport = recordingTransport()
    const port = createAnalyticsPort<AgentQaAnalyticsEvent>({
      transport,
      identity: () => ({ distinctId: 'u_test-identity' }),
    })
    const subscriber = createAnalyticsRunSubscriber({
      port,
      triggerSource: 'cli',
      runner: 'local',
      standardProperties: { surface: 'cli', runtime_context: 'user' },
    })
    return { transport, subscriber }
  }

  it('captures a test_run completion member through the injected port', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('runStarted', { memberTestCount: 1 }))
    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'a test' }))
    subscriber.handler(envelope('stepFinalized', { testIndex: 0, stepIndex: 0, status: 'passed' }))
    subscriber.handler(envelope('stepFinalized', { testIndex: 0, stepIndex: 1, status: 'failed' }))
    subscriber.handler(envelope('stepFinalized', { testIndex: 0, stepIndex: 2, status: 'skipped' }))
    subscriber.handler(
      envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 420, retryCount: 1 }),
    )
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    const events = eventsOf(transport)
    expect(events.map((event) => event.name)).toEqual(['agent-qa.test_run.completed'])
    expect(events[0]?.properties).toEqual({
      surface: 'cli',
      runtime_context: 'user',
      run_id: runId,
      test_id: testId,
      trigger_source: 'cli',
      runner: 'local',
      status: 'passed',
      duration_ms: 420,
      retry_count: 1,
      is_flaky: true,
      step_count: 3,
      passed_step_count: 1,
      failed_step_count: 1,
      skipped_step_count: 1,
    })
  })

  it('emits a suite_run completion member alongside its members when the run had a suite', async () => {
    const { transport, subscriber } = harness()
    const secondTestId = generateTestId()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'one', suiteId }))
    subscriber.handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 10 }))
    subscriber.handler(
      envelope('testStarted', { testId: secondTestId, testIndex: 1, name: 'two', suiteId }),
    )
    subscriber.handler(
      envelope('testFinished', { testId: secondTestId, testIndex: 1, outcome: 'failed', durationMs: 30 }),
    )
    subscriber.handler(envelope('verdict', { verdict: 'failed' }))
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'failed' }))
    await subscriber.flush()

    const events = eventsOf(transport)
    expect(events.map((event) => event.name)).toEqual([
      'agent-qa.test_run.completed',
      'agent-qa.test_run.completed',
      'agent-qa.suite_run.completed',
    ])
    expect(events[2]?.properties).toMatchObject({
      run_id: runId,
      suite_id: suiteId,
      status: 'failed',
      duration_ms: 40,
      suite_child_count: 2,
      suite_passed_count: 1,
      suite_failed_count: 1,
      suite_skipped_count: 0,
    })
  })

  it('emits only members of the closed union — every captured event parses', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'one', suiteId }))
    subscriber.handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'healed', durationMs: 5 }))
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    expect(transport.payloads.length).toBe(2)
    for (const event of eventsOf(transport)) {
      expect(() => AgentQaAnalyticsEventSchema.parse(event)).not.toThrow()
    }
  })

  it('drops an id that is not a canonical id rather than emitting it into a known-id field', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(
      envelope('testStarted', { testId: 'not-a-test-id', testIndex: 0, name: 'one', suiteId: 'nope' }),
    )
    subscriber.handler(
      envelope('testFinished', { testId: 'not-a-test-id', testIndex: 0, outcome: 'passed' }),
    )
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    const events = eventsOf(transport)
    // A foreign string reaching `test_id` would be exactly the free-text channel the union closes,
    // so the subscriber drops the field instead of forwarding it.
    expect(events[0]?.properties).not.toHaveProperty('test_id')
    for (const event of events) {
      expect(() => AgentQaAnalyticsEventSchema.parse(event)).not.toThrow()
    }
  })

  it('resets a member step tally when the member is retried, so a re-run never double-counts', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'flaky' }))
    subscriber.handler(envelope('stepFinalized', { testIndex: 0, stepIndex: 0, status: 'failed' }))
    subscriber.handler(envelope('testRetryScheduled', { testIndex: 0 }))
    subscriber.handler(envelope('stepFinalized', { testIndex: 0, stepIndex: 0, status: 'passed' }))
    subscriber.handler(
      envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', retryCount: 1 }),
    )
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    expect(eventsOf(transport)[0]?.properties).toMatchObject({
      step_count: 1,
      passed_step_count: 1,
      failed_step_count: 0,
    })
  })

  it('emits nothing when the run never finished, and still settles the port', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'one' }))
    subscriber.handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'passed' }))
    await subscriber.flush()

    expect(transport.payloads).toEqual([])
  })

  it('never throws into the run on a malformed envelope', async () => {
    const { transport, subscriber } = harness()

    expect(() => subscriber.handler(envelope('testStarted', null))).not.toThrow()
    expect(() => subscriber.handler(envelope('stepFinalized', undefined))).not.toThrow()
    expect(() => subscriber.handler(envelope('testFinished', 7))).not.toThrow()
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await expect(subscriber.flush()).resolves.toBeUndefined()
    expect(transport.payloads).toEqual([])
  })
})
