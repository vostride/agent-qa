// A disconnect on its own fails the member; only a received cancel makes it `cancelled`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'

import { makeAdapter, makePlanner } from '../../loop/__tests__/loop-harness.js'
import type { PlatformAdapter } from '../../platform.js'
import type { StepResult } from '../../result.js'
import { runMemberTest } from '../member-runner.js'
import type { MemberRunConfig } from '../member-runner.js'

const BROWSER_CLOSED = 'The browser closed before this test finished.'
const LOST = 'The connection to remote grid (playwright ws://127.0.0.1:9) was lost while this test ran.'
const ENDED = 'Remote grid (playwright ws://127.0.0.1:9) ended the session while this test ran.'

function disconnectedAdapter(): PlatformAdapter & { isBrowserDisconnected: boolean } {
  return Object.assign(makeAdapter(), { isBrowserDisconnected: false })
}

type RemoteAdapter = PlatformAdapter & {
  isBrowserDisconnected: boolean
  disconnectSummary: string | undefined
  settleDisconnect(): Promise<void>
}

// Names the remote as lost at the drop; `settling` decides when, if ever, the kind is known.
function remoteAdapter(settling: (adapter: RemoteAdapter) => Promise<void>): {
  adapter: RemoteAdapter
  closingStep: (instruction: string) => Promise<StepResult>
} {
  let settled: Promise<void> | undefined
  const adapter: RemoteAdapter = Object.assign(makeAdapter(), {
    isBrowserDisconnected: false,
    disconnectSummary: undefined as string | undefined,
    settleDisconnect: () => settled ?? Promise.resolve(),
  })
  const closingStep = async (instruction: string): Promise<StepResult> => {
    adapter.isBrowserDisconnected = true
    adapter.disconnectSummary = LOST
    settled = settling(adapter)
    return { name: instruction, status: 'failed', duration: 1, error: 'Target page, context or browser has been closed' }
  }
  return { adapter, closingStep }
}

afterEach(() => {
  vi.useRealTimers()
})

function memberConfig(overrides: Partial<MemberRunConfig>): MemberRunConfig {
  return {
    adapter: makeAdapter(),
    planner: makePlanner(),
    plannerModel: {} as unknown as LanguageModel,
    verifierModel: {} as unknown as LanguageModel,
    sink: {
      stepStarted() {},
      loopEmitFor() {
        return { stepFinalized() {}, subActionRecorded() {} }
      },
      hookStarted() {},
      hookFinished() {},
      testRetryScheduled() {},
    },
    testIndex: 0,
    abortSignal: new AbortController().signal,
    ...overrides,
  } as MemberRunConfig
}

const member = { testId: 't_member', name: 'Member test', filePath: '/tests/member.yaml', steps: ['Click OK'] }

describe('a closed browser is not a cancel', () => {
  it('a browser that closes with no cancel fails the member and says the browser closed', async () => {
    const adapter = disconnectedAdapter()
    const closing = async (instruction: string): Promise<StepResult> => {
      adapter.isBrowserDisconnected = true
      return { name: instruction, status: 'failed', duration: 1, error: 'Target page, context or browser has been closed' }
    }
    const result = await runMemberTest(member, memberConfig({ adapter, executeStep: closing }))

    expect(result.status).toBe('failed')
    expect(result.failureSummary).toBe(BROWSER_CLOSED)
  })

  it('a cancelled member stays cancelled with its cancel summary when the browser also closed', async () => {
    const adapter = disconnectedAdapter()
    const external = new AbortController()
    let started = false
    const hanging = async (): Promise<StepResult> => {
      started = true
      return new Promise<StepResult>(() => undefined)
    }
    const running = runMemberTest(member, memberConfig({ adapter, executeStep: hanging, abortSignal: external.signal }))
    while (!started) await new Promise((tick) => setTimeout(tick, 1))
    adapter.isBrowserDisconnected = true
    external.abort(new Error('stop'))
    const result = await running

    expect(result.status).toBe('cancelled')
    expect(result.failureSummary).toBe('Test cancelled after 1 step(s)')
  })

  it('a dropped remote fails the member with the sentence its adapter settles on, after waiting for it', async () => {
    const { adapter, closingStep } = remoteAdapter((dropped) => new Promise<void>((resolve) => {
      setTimeout(() => {
        dropped.disconnectSummary = ENDED
        resolve()
      }, 50)
    }))
    const result = await runMemberTest(member, memberConfig({ adapter, executeStep: closingStep }))

    expect(result.status).toBe('failed')
    expect(result.failureSummary).toBe(ENDED)
  })

  it('a dropped remote whose kind never settles fails the member with the lost sentence once the bound passes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { adapter, closingStep } = remoteAdapter(() => new Promise<void>(() => undefined))
    let finished = false
    const running = runMemberTest(member, memberConfig({ adapter, executeStep: closingStep }))
      .finally(() => { finished = true })

    await vi.advanceTimersByTimeAsync(2_999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await running

    expect(finished).toBe(true)
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toBe(LOST)
  })
})
