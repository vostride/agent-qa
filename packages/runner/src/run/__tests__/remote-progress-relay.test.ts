// A host's plugin progress reaches the run's bus while it is open, masked by the run's redactor.

import { describe, expect, it } from 'vitest'

import type { RemoteProgressPayload, RunEventEnvelope, ScopeKey } from '@vostride/agent-qa-schema'

import { startRun } from '../shell.js'
import type { MemberTestExecutor, RunConfig } from '../shell.js'
import type { EventLogPort, RemoteProgressRelay } from '../ports.js'
import { SecretRedactor, SecretStore } from '../../loop/secrets.js'

const SECRET = 'S3CR3T-lab-pool-token'
const SCOPE: ScopeKey = { tier: 'suite', key: 'checkout' }

function capturingLog(): { port: EventLogPort; lines: RunEventEnvelope[] } {
  const lines: RunEventEnvelope[] = []
  return {
    lines,
    port: {
      append(envelope: RunEventEnvelope) {
        lines.push(envelope)
      },
      read(fromSeq: number) {
        return lines.filter((event) => event.seq >= fromSeq)
      },
    },
  }
}

interface ScriptedRelay extends RemoteProgressRelay {
  emit(payload: RemoteProgressPayload): void
  attached(): boolean
}

function scriptedRelay(): ScriptedRelay {
  let publish: ((payload: RemoteProgressPayload) => void) | undefined
  return {
    attach(next) {
      publish = next
      return () => {
        publish = undefined
      }
    },
    emit(payload) {
      publish?.(payload)
    },
    attached: () => publish !== undefined,
  }
}

function configWith(
  executor: MemberTestExecutor,
  eventLog: EventLogPort,
  relay?: RemoteProgressRelay,
): RunConfig {
  return {
    runId: 'run-progress' as RunConfig['runId'],
    scope: SCOPE,
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }],
    executor,
    secretRedactor: new SecretRedactor(new SecretStore({ LAB_TOKEN: SECRET })),
    ports: { eventLog, ...(relay === undefined ? {} : { remoteProgress: relay }) },
  }
}

const passed = (name: string) => ({
  name,
  filePath: `${name}.test.ts`,
  status: 'passed' as const,
  steps: [],
  duration: 1,
})

describe('a remote progress relay', () => {
  it('publishes each emit as one remoteProgress with its message masked by the run', async () => {
    const relay = scriptedRelay()
    const log = capturingLog()
    const executor: MemberTestExecutor = async (member) => {
      relay.emit({
        remote: 'lab',
        message: `queued, 3 ahead on ${SECRET}`,
        testIndex: 0,
        queued: 3,
      })
      return passed(member.testId)
    }

    await startRun(configWith(executor, log.port, relay)).done

    const progress = log.lines.filter((event) => event.type === 'remoteProgress')
    expect(progress.map((event) => event.payload)).toEqual([
      { remote: 'lab', message: 'queued, 3 ahead on [secret:LAB_TOKEN]', testIndex: 0, queued: 3 },
    ])
    const types = log.lines.map((event) => event.type)
    expect(types.indexOf('runStarted')).toBeLessThan(types.indexOf('remoteProgress'))
    expect(types.indexOf('remoteProgress')).toBeLessThan(types.indexOf('verdict'))
  })

  it('is detached before the verdict, so a later emit publishes nothing', async () => {
    const relay = scriptedRelay()
    const log = capturingLog()
    const session = startRun(configWith(async (member) => passed(member.testId), log.port, relay))
    expect(relay.attached()).toBe(true)

    await session.done
    relay.emit({ remote: 'lab', message: 'queued, 1 ahead' })

    expect(relay.attached()).toBe(false)
    expect(log.lines.filter((event) => event.type === 'remoteProgress')).toEqual([])
    expect(log.lines.filter((event) => event.type === 'runWarning')).toEqual([])
  })

  it('is detached when the run throws before its verdict', async () => {
    const relay = scriptedRelay()
    const log = capturingLog()
    // A result that is not a TestResult throws while the run reads it, past the member's catch.
    const notAResult: MemberTestExecutor = async () =>
      null as unknown as Awaited<ReturnType<MemberTestExecutor>>
    const session = startRun(configWith(notAResult, log.port, relay))
    expect(relay.attached()).toBe(true)

    await expect(session.done).rejects.toThrow()

    expect(relay.attached()).toBe(false)
    expect(log.lines.some((event) => event.type === 'verdict')).toBe(false)
  })

  it('a run given no relay publishes no remoteProgress', async () => {
    const log = capturingLog()

    await startRun(configWith(async (member) => passed(member.testId), log.port)).done

    expect(log.lines.some((event) => event.type === 'remoteProgress')).toBe(false)
    expect(log.lines.at(-1)?.type).toBe('runFinished')
  })

  it('turns a relay whose attach throws into one runWarning and runs on', async () => {
    const log = capturingLog()
    const broken: RemoteProgressRelay = {
      attach() {
        throw new Error('the relay is broken')
      },
    }

    const completion = await startRun(
      configWith(async (member) => passed(member.testId), log.port, broken),
    ).done

    expect(completion.verdict).toBe('passed')
    const warnings = log.lines.filter((event) => event.type === 'runWarning')
    expect(warnings.map((event) => event.payload)).toEqual([
      { code: 'event-sink-error', message: 'the relay is broken' },
    ])
  })
})
