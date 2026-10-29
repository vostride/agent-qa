// @vitest-environment jsdom

// The poll interval and timeout live in refs and clear on every exit, so no poll outlives the flow.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSignInFlow, type SignInCompletion, type SignInFlow } from '@/hooks/use-sign-in-flow'
import { ApiError, exchangePluginAuthCode, pollPluginAuthResult, startPluginAuth } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  startPluginAuth: vi.fn(),
  pollPluginAuthResult: vi.fn(),
  exchangePluginAuthCode: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AUTHORIZE_URL = 'https://auth.example/authorize'
const FIVE_MINUTES = 5 * 60 * 1000

let flow: SignInFlow | undefined
const completions: SignInCompletion[] = []

function FlowHarness() {
  const current = useSignInFlow({ onCompleted: (completion) => completions.push(completion) })
  flow = current
  return (
    <div
      data-testid="flow"
      data-state={current.state}
      data-mode={current.mode ?? ''}
      data-reason={current.reason ?? ''}
      data-created={current.created === undefined ? '' : String(current.created)}
    />
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let openSpy: ReturnType<typeof vi.spyOn> | undefined

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<FlowHarness />)
  })
  await flush()
}

async function unmount() {
  if (root) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
}

function read() {
  const element = container!.querySelector('[data-testid="flow"]')!
  return {
    state: element.getAttribute('data-state'),
    mode: element.getAttribute('data-mode'),
    reason: element.getAttribute('data-reason'),
    created: element.getAttribute('data-created'),
  }
}

async function start(provider: string, name: string) {
  await act(async () => {
    await flow!.start(provider, name)
  })
  await flush()
}

function answerStart(mode: 'browser-poll' | 'manual-code', created: boolean) {
  vi.mocked(startPluginAuth).mockResolvedValueOnce({ authorizeUrl: AUTHORIZE_URL, sessionId: 'session-1', mode, created })
}

beforeEach(() => {
  vi.useFakeTimers()
  completions.length = 0
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  vi.mocked(pollPluginAuthResult).mockResolvedValue({ status: 'pending' })
})

afterEach(async () => {
  await unmount()
  openSpy?.mockRestore()
  vi.clearAllMocks()
  vi.useRealTimers()
  flow = undefined
})

describe('useSignInFlow', () => {
  it('SIGN-IN-BROWSER-POLL: starts the sign-in for the name, opens the provider page, polls every 2 s and completes with the created flag', async () => {
    await mount()
    expect(read().state).toBe('idle')
    answerStart('browser-poll', true)
    await start('openai-subscription', 'gpt-5.6')

    expect(startPluginAuth).toHaveBeenCalledWith('openai-subscription', 'gpt-5.6')
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy!.mock.calls[0][0]).toBe(AUTHORIZE_URL)
    expect(openSpy!.mock.calls[0][1]).toBe('_blank')
    expect(read()).toMatchObject({ state: 'waiting', mode: 'browser-poll' })
    expect(pollPluginAuthResult).not.toHaveBeenCalled()

    await advance(1999)
    expect(pollPluginAuthResult).not.toHaveBeenCalled()
    await advance(1)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(1)
    expect(pollPluginAuthResult).toHaveBeenLastCalledWith('openai-subscription', 'session-1')
    expect(read().state).toBe('waiting')

    vi.mocked(pollPluginAuthResult).mockResolvedValueOnce({ status: 'completed', saved: true })
    await advance(2000)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(2)
    expect(read()).toMatchObject({ state: 'completed', created: 'true' })
    expect(completions).toEqual([{ provider: 'openai-subscription', name: 'gpt-5.6', created: true }])

    await advance(20_000)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(2)
    expect(completions).toHaveLength(1)
  })

  it('SIGN-IN-MANUAL-CODE: a manual-code sign-in waits for the code without polling, then exchanges it and completes', async () => {
    await mount()
    answerStart('manual-code', false)
    await start('anthropic-subscription', 'claude')

    expect(read()).toMatchObject({ state: 'awaiting-code', mode: 'manual-code' })
    expect(openSpy!.mock.calls[0][0]).toBe(AUTHORIZE_URL)
    await advance(10_000)
    expect(pollPluginAuthResult).not.toHaveBeenCalled()

    vi.mocked(exchangePluginAuthCode).mockResolvedValueOnce({ status: 'completed', saved: true })
    await act(async () => {
      await flow!.submitCode('  code-from-page  ')
    })
    await flush()
    expect(exchangePluginAuthCode).toHaveBeenCalledWith('anthropic-subscription', 'session-1', 'code-from-page')
    expect(read()).toMatchObject({ state: 'completed', created: 'false' })
    expect(completions).toEqual([{ provider: 'anthropic-subscription', name: 'claude', created: false }])
  })

  it('SIGN-IN-TIMEOUT: five minutes without a result reports timed-out and stops polling', async () => {
    await mount()
    answerStart('browser-poll', true)
    await start('openai-subscription', 'gpt-5.6')

    await advance(FIVE_MINUTES - 1)
    expect(read().state).toBe('waiting')
    await advance(1)
    expect(read().state).toBe('timed-out')
    const polls = vi.mocked(pollPluginAuthResult).mock.calls.length
    expect(polls).toBeGreaterThan(100)
    await advance(60_000)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(polls)
    expect(completions).toHaveLength(0)
  })

  it('CANCEL-SIGN-IN: cancel clears the interval and the timeout, and a poll already in flight is ignored', async () => {
    await mount()
    answerStart('browser-poll', true)
    await start('openai-subscription', 'gpt-5.6')
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const clearTimeout = vi.spyOn(window, 'clearTimeout')

    let resolvePoll!: (value: { status: 'completed'; saved: boolean }) => void
    vi.mocked(pollPluginAuthResult).mockReturnValueOnce(new Promise((resolve) => {
      resolvePoll = resolve
    }))
    await advance(2000)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(1)

    await act(async () => {
      flow!.cancel()
    })
    await flush()
    expect(read().state).toBe('idle')
    expect(clearInterval).toHaveBeenCalled()
    expect(clearTimeout).toHaveBeenCalled()

    await act(async () => {
      resolvePoll({ status: 'completed', saved: true })
    })
    await flush()
    await advance(FIVE_MINUTES + 10_000)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(1)
    expect(read().state).toBe('idle')
    expect(completions).toHaveLength(0)
  })

  it('TIMERS-CLEARED-ON-UNMOUNT: unmounting while waiting clears the interval and the timeout, so nothing polls afterwards', async () => {
    await mount()
    answerStart('browser-poll', true)
    await start('openai-subscription', 'gpt-5.6')
    await advance(2000)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(1)
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const clearTimeout = vi.spyOn(window, 'clearTimeout')

    await unmount()
    expect(clearInterval).toHaveBeenCalled()
    expect(clearTimeout).toHaveBeenCalled()
    await advance(FIVE_MINUTES + 10_000)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(1)
    expect(completions).toHaveLength(0)
  })

  it('SIGN-IN-POLL-ERROR: a poll answering error reports failed with its reason and stops; a refused start fails with the server sentence', async () => {
    await mount()
    answerStart('browser-poll', true)
    await start('openai-subscription', 'gpt-5.6')
    vi.mocked(pollPluginAuthResult).mockResolvedValueOnce({ status: 'error', error: 'The sign-in was denied.' })
    await advance(2000)
    expect(read()).toMatchObject({ state: 'failed', reason: 'The sign-in was denied.' })
    await advance(20_000)
    expect(pollPluginAuthResult).toHaveBeenCalledTimes(1)

    vi.mocked(startPluginAuth).mockRejectedValueOnce(
      new ApiError(409, 'Conflict', { error: 'credential_provider_conflict', message: 'Another provider holds that name.' }),
    )
    await start('openai-subscription', 'shared')
    expect(read()).toMatchObject({ state: 'failed', reason: 'Another provider holds that name.' })
    expect(completions).toHaveLength(0)
  })
})
