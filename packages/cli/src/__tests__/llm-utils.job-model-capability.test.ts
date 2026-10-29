// The CLI's binding of the job queue's authorship capability (385 plan 09, over plan 05's D-10).
//
// The lazy-wrong implementation of "composeLocalAgent binds a real model" is a capability whose
// `generate` throws or answers a constant — nothing in this phase pumps a job through the CLI, so a
// stub would be invisible. These assertions are therefore about the CALL: that the profile really
// reaches `createModel`, that the request the queue hands in becomes the provider request, and that
// the answer comes back from the provider rather than from a literal here.

import type { ModelProfile, ResolvedModelAuth } from '@vostride/agent-qa-model'
import { describe, expect, it, vi } from 'vitest'

import { buildJobModelCapability } from '../llm-utils.js'

const PROFILE: ModelProfile = {
  provider: 'openai-compatible',
  model: 'gpt-4.1-mini',
  auth: { mode: 'api-key' },
}

const AUTH: ResolvedModelAuth = { kind: 'api-key', apiKey: 'sk-fixture' }

function deps(overrides: Record<string, unknown> = {}) {
  const handle = { __handle: 'created-from-profile' }
  const generateTextImpl = vi.fn(
    async (_request: Record<string, unknown>) => ({ text: 'the provider answer' }),
  )
  return {
    handle,
    generateTextImpl,
    injected: {
      createModelImpl: vi.fn(() => handle),
      createTokenAccountingImpl: vi.fn(() => ({ getCeilings: () => ({ maxOutput: 512 }) })),
      resolveCapabilitiesImpl: vi.fn(() => ({ contextWindow: 100_000, maxOutput: 512 })),
      generateTextImpl,
      ...overrides,
    } as never,
  }
}

describe('buildJobModelCapability', () => {
  it('names the model by the profile it was built from', () => {
    const { injected } = deps()
    expect(buildJobModelCapability(PROFILE, AUTH, (text) => text, injected).modelId)
      .toBe('openai-compatible:gpt-4.1-mini')
  })

  it('calls the provider with the request the queue handed in, and returns its text', async () => {
    const { handle, generateTextImpl, injected } = deps()

    const answer = await buildJobModelCapability(PROFILE, AUTH, (text) => text, injected)
      .generate({ system: 'you summarise runs', prompt: 'summarise run_1' })

    expect(answer).toEqual({ text: 'the provider answer' })
    expect(generateTextImpl).toHaveBeenCalledTimes(1)
    expect(generateTextImpl.mock.calls[0]?.[0]).toMatchObject({
      model: handle,
      system: 'you summarise runs',
      prompt: 'summarise run_1',
      // Deterministic by construction: an authored checkpoint is memoized and replayed, so an
      // answer that depended on sampling or on which retry produced it would make the resumed
      // value disagree with the one the first host recorded.
      temperature: 0,
      maxRetries: 0,
      maxOutputTokens: 512,
    })
  })

  it('omits the system turn entirely when the request carries none', async () => {
    const { generateTextImpl, injected } = deps()

    await buildJobModelCapability(PROFILE, AUTH, (text) => text, injected).generate({ prompt: 'no system turn' })

    expect(generateTextImpl.mock.calls[0]?.[0]).not.toHaveProperty('system')
  })

  it('builds the provider handle from the profile and auth it was given', () => {
    const { injected } = deps()
    buildJobModelCapability(PROFILE, AUTH, (text) => text, injected)
    expect((injected as { createModelImpl: ReturnType<typeof vi.fn> }).createModelImpl)
      .toHaveBeenCalledWith(PROFILE, AUTH, expect.any(Function))
  })
})

describe('the job model request signal', () => {
  it('the job model passes the request signal to the model call', async () => {
    const { generateTextImpl, injected } = deps()
    const capability = buildJobModelCapability(PROFILE, AUTH, (text) => text, injected)
    const controller = new AbortController()

    await capability.generate({ prompt: 'summarise run_1', signal: controller.signal })
    await capability.generate({ prompt: 'no signal' })

    expect(generateTextImpl).toHaveBeenCalledTimes(2)
    expect(generateTextImpl.mock.calls[0]?.[0]).toMatchObject({ prompt: 'summarise run_1' })
    expect(generateTextImpl.mock.calls[0]?.[0]?.abortSignal).toBe(controller.signal)
    expect(generateTextImpl.mock.calls[1]?.[0]).not.toHaveProperty('abortSignal')
  })
})
