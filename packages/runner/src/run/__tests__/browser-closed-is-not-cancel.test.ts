// A disconnect on its own fails the member; only a received cancel makes it `cancelled`.
import { describe, expect, it } from 'vitest'
import type { LanguageModel } from 'ai'

import { makeAdapter, makePlanner } from '../../loop/__tests__/loop-harness.js'
import type { PlatformAdapter } from '../../platform.js'
import type { StepResult } from '../../result.js'
import { runMemberTest } from '../member-runner.js'
import type { MemberRunConfig } from '../member-runner.js'

const BROWSER_CLOSED = 'The browser closed before this test finished.'

function disconnectedAdapter(): PlatformAdapter & { isBrowserDisconnected: boolean } {
  return Object.assign(makeAdapter(), { isBrowserDisconnected: false })
}

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
})
