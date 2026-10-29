import { describe, expect, it, vi } from 'vitest'
import type {
  LiveStreamCapability,
  MemberTestRunContext,
  PlatformAdapter,
} from '@vostride/agent-qa-runner'
import { registerAdapterLiveStream } from '../run-composition.js'

vi.mock('@vostride/agent-qa-web', () => ({ runAccessibilityCheck: vi.fn(async () => []) }))

function baseAdapter(): PlatformAdapter {
  return {
    platform: 'web',
    setup: async () => {},
    cleanup: async () => {},
    observe: async () => {
      throw new Error('observe is not part of registration')
    },
    execute: async () => ({ success: true }),
  }
}

function contextWith(
  registerLiveStream: (capability?: LiveStreamCapability, fallback?: LiveStreamCapability) => void,
): MemberTestRunContext {
  return { registerLiveStream } as unknown as MemberTestRunContext
}

describe('registerAdapterLiveStream (428 D-11/D-12)', () => {
  it('REGISTERS-CAPABILITY-AND-FALLBACK: a screencast adapter registers its screencast with a snapshot fallback', () => {
    const screencast: LiveStreamCapability = {
      kind: 'cdp-screencast',
      async start() {},
      async ack() {},
      async stop() {},
    }
    const adapter: PlatformAdapter = {
      ...baseAdapter(),
      liveStream: screencast,
      screenshot: async () => undefined,
    }
    const register = vi.fn()
    registerAdapterLiveStream(contextWith(register), adapter)
    expect(register).toHaveBeenCalledTimes(1)
    const [capability, fallback] = register.mock.calls[0] as [
      LiveStreamCapability | undefined,
      LiveStreamCapability | undefined,
    ]
    expect(capability).toBe(screencast)
    expect(fallback?.kind).toBe('snapshot')
  })

  it('REGISTERS-CAPABILITY-AND-FALLBACK: an adapter with neither registers nothing, explicitly', () => {
    const register = vi.fn()
    registerAdapterLiveStream(contextWith(register), baseAdapter())
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(undefined, undefined)
  })
})
