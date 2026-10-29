import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { composeAnalytics } from '../compose.js'
import { PACKAGE_SRC_DIR, packageSourceFiles } from './source-scan.js'
import type { ComposeAnalyticsOptions } from '../compose.js'
import type { AnalyticsCapturePayload, AnalyticsTransport } from '../port.js'
import type { PosthogTransportFactory, PosthogTransportOptions } from '../transports.js'

/** A transport that records what reached it, so "zero attempts" is observed rather than assumed. */
class CountingSink implements AnalyticsTransport {
  readonly captured: AnalyticsCapturePayload[] = []
  flushCount = 0
  shutdownCount = 0

  capture(payload: AnalyticsCapturePayload): void {
    this.captured.push(payload)
  }

  flush(): void {
    this.flushCount += 1
  }

  shutdown(): void {
    this.shutdownCount += 1
  }
}

class ThrowingTransport implements AnalyticsTransport {
  capture(): void {
    throw new Error('capture exploded')
  }

  flush(): Promise<void> {
    return Promise.reject(new Error('flush exploded'))
  }

  shutdown(): Promise<void> {
    return Promise.reject(new Error('shutdown exploded'))
  }
}

/** Records whether the PostHog transport was CONSTRUCTED at all — the structural half of D-19. */
function spyingPosthogFactory(): { factory: PosthogTransportFactory; calls: PosthogTransportOptions[] } {
  const calls: PosthogTransportOptions[] = []
  return {
    calls,
    factory: (options) => {
      calls.push(options)
      return new CountingSink()
    },
  }
}

const ENABLED_KEY = 'phc_test_key'

describe('composeAnalytics — the one opt-out decision', () => {
  it.each([
    { label: 'privacy true', config: { analytics: { privacy: true } }, optedOut: true },
    { label: 'privacy false', config: { analytics: { privacy: false } }, optedOut: false },
    { label: 'privacy absent', config: { analytics: {} }, optedOut: false },
    { label: 'no analytics block', config: {}, optedOut: false },
  ])('$label resolves optedOut=$optedOut', ({ config, optedOut }) => {
    const sink = new CountingSink()
    const composed = composeAnalytics({ config, projectKey: ENABLED_KEY, transportOverride: sink })

    expect(composed.optedOut).toBe(optedOut)
    expect(composed.transportKind).toBe(optedOut ? 'none' : 'posthog')
    expect(composed.transport === undefined).toBe(optedOut)
  })

  // THE STRUCTURAL CLAIM, and the one a `disabled` boolean cannot make. It is not that the PostHog
  // transport declines to send when opted out — it is that no PostHog transport was ever built, so
  // the process holds no live client for a later code path to find.
  it('opted out constructs NO PostHog transport at all', () => {
    const spy = spyingPosthogFactory()
    const composed = composeAnalytics({
      config: { analytics: { privacy: true } },
      projectKey: ENABLED_KEY,
      posthogTransportFactory: spy.factory,
    })

    expect(spy.calls).toEqual([])
    expect(composed.transport === undefined).toBe(true)
  })

  it('opted in constructs the PostHog transport exactly once, with the resolved key and host', () => {
    const spy = spyingPosthogFactory()
    composeAnalytics({
      projectKey: ENABLED_KEY,
      projectHost: 'https://sink.invalid',
      posthogTransportFactory: spy.factory,
    })

    expect(spy.calls.length).toBe(1)
    expect(spy.calls[0]?.projectKey).toBe(ENABLED_KEY)
    expect(spy.calls[0]?.host).toBe('https://sink.invalid')
  })

  // A transport handed in by a caller must not be able to undo the decision. If the override were
  // honoured on the opted-out arm it would be a second door onto the wire, which is the exact shape
  // D-19 exists to remove.
  it('an opted-out composition ignores a transport override entirely', async () => {
    const sink = new CountingSink()
    const composed = composeAnalytics({
      config: { analytics: { privacy: true } },
      projectKey: ENABLED_KEY,
      transportOverride: sink,
    })

    composed.port.capture({ name: 'agent-qa.probe', properties: {} })
    await composed.port.flush()

    expect(sink.captured).toEqual([])
    expect(sink.flushCount).toBe(0)
    expect(composed.transport === undefined).toBe(true)
  })

  // An empty project key is not an opt-out — it is nothing to send TO. Kept distinct because
  // conflating them would report a developer checkout as a user who declined.
  it('an empty project key yields a noop transport without claiming the user opted out', () => {
    const spy = spyingPosthogFactory()
    const composed = composeAnalytics({ projectKey: '   ', posthogTransportFactory: spy.factory })

    expect(composed.optedOut).toBe(false)
    expect(composed.optOutReasons).toEqual([])
    expect(composed.transportKind).toBe('none')
    expect(spy.calls).toEqual([])
  })
})

describe('AnalyticsPort — best-effort boundary and the empty queue', () => {
  it('never throws into the host, whatever the transport does', async () => {
    const composed = composeAnalytics({
      projectKey: ENABLED_KEY,
      transportOverride: new ThrowingTransport(),
    })

    expect(() => composed.port.capture({ name: 'agent-qa.probe', properties: {} })).not.toThrow()
    await expect(composed.port.flush()).resolves.toBeUndefined()
    await expect(composed.port.shutdown()).resolves.toBeUndefined()
  })

  // MEASURED, not assumed (398-03 mutation leg M6). The cell above was VACUOUS for the synchronous
  // guard: `ThrowingTransport.capture` is reached from inside an async body, so its throw is
  // already a rejected promise and the `.catch` handles it — deleting `capture`'s try/catch
  // outright left all 32 cells green. The only thing that can throw SYNCHRONOUSLY out of `capture`
  // is the identity resolver, so that is what this drives. Plan 06 re-homes the real resolver, and
  // the real one reads a file.
  it('swallows a SYNCHRONOUS throw out of the identity resolver', () => {
    const sink = new CountingSink()
    const composed = composeAnalytics({
      projectKey: ENABLED_KEY,
      transportOverride: sink,
      identity: () => {
        throw new Error('identity store unreadable')
      },
    })

    expect(() => composed.port.capture({ name: 'agent-qa.probe', properties: {} })).not.toThrow()
    expect(sink.captured).toEqual([])
  })

  // The other half of the same boundary: a capture whose transport rejects and which is NEVER
  // flushed must not surface as an unhandled rejection. A host that emits on a path it does not
  // await is the normal case, so "nobody called flush" is not an unusual state to be in.
  it('a captured event whose transport rejects, never flushed, raises no unhandled rejection', async () => {
    const seen: unknown[] = []
    const listener = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      const composed = composeAnalytics({
        projectKey: ENABLED_KEY,
        transportOverride: new ThrowingTransport(),
      })
      composed.port.capture({ name: 'agent-qa.probe', properties: {} })
      // Two macrotask turns: Node reports an unhandled rejection at the end of the turn in which
      // the promise settled with no handler attached.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', listener)
    }

    expect(seen).toEqual([])
  })

  it('flush on an empty queue makes NO call on the transport and still resolves', async () => {
    const sink = new CountingSink()
    const composed = composeAnalytics({ projectKey: ENABLED_KEY, transportOverride: sink })

    await expect(composed.port.flush()).resolves.toBeUndefined()

    expect(sink.captured).toEqual([])
    expect(sink.flushCount).toBe(0)
  })

  it('flush after a capture reaches the transport exactly once', async () => {
    const sink = new CountingSink()
    const composed = composeAnalytics({
      projectKey: ENABLED_KEY,
      transportOverride: sink,
      identity: () => ({ distinctId: 'u_compose-cell' }),
    })

    composed.port.capture({ name: 'agent-qa.probe', properties: { surface: 'cli' } })
    await composed.port.flush()

    expect(sink.captured.map((payload) => payload.event.name)).toEqual(['agent-qa.probe'])
    expect(sink.captured[0]?.distinctId).toBe('u_compose-cell')
    expect(sink.flushCount).toBe(1)

    // And a second flush with nothing new captured is a no-op again — the counter resets with the
    // queue, so "empty" is a property of the interval rather than of the port's whole lifetime.
    await composed.port.flush()
    expect(sink.flushCount).toBe(1)
  })

  it('shutdown reaches the transport even when nothing was ever captured', async () => {
    const sink = new CountingSink()
    const composed = composeAnalytics({ projectKey: ENABLED_KEY, transportOverride: sink })

    await composed.port.shutdown()

    expect(sink.shutdownCount).toBe(1)
    expect(sink.flushCount).toBe(0)
  })
})

describe('DO_NOT_TRACK is not an opt-out', () => {
  it('the config privacy flag is the only opt-out', () => {
    const first = spyingPosthogFactory()
    const withVariable = composeAnalytics({
      env: { DO_NOT_TRACK: '1' },
      projectKey: ENABLED_KEY,
      posthogTransportFactory: first.factory,
    } as ComposeAnalyticsOptions)

    expect(withVariable.optedOut).toBe(false)
    expect(withVariable.optOutReasons).toEqual([])
    expect(withVariable.transportKind).toBe('posthog')
    expect(first.calls.length).toBe(1)

    const second = spyingPosthogFactory()
    const withPrivacy = composeAnalytics({
      config: { analytics: { privacy: true } },
      projectKey: ENABLED_KEY,
      posthogTransportFactory: second.factory,
    })

    expect(withPrivacy.optedOut).toBe(true)
    expect(withPrivacy.optOutReasons).toEqual(['config-privacy'])
    expect(second.calls).toEqual([])
  })

  it('no shipped source in analytics or cli spells DO_NOT_TRACK', () => {
    const files = [
      ...packageSourceFiles(PACKAGE_SRC_DIR),
      ...packageSourceFiles(join(PACKAGE_SRC_DIR, '..', '..', 'cli', 'src')),
    ]
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('DO_NOT_TRACK'))

    expect(files.length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})

describe('an opted-out or keyless composition holds no transport', () => {
  it('an opted-out or keyless composition holds no transport object', async () => {
    const arms = [
      {
        options: { config: { analytics: { privacy: true } }, projectKey: ENABLED_KEY },
        optedOut: true,
      },
      { options: { projectKey: '   ' }, optedOut: false },
    ]

    for (const arm of arms) {
      const spy = spyingPosthogFactory()
      const identity = vi.fn(() => ({ distinctId: 'u_should-never-be-resolved' }))
      const composed = composeAnalytics({
        ...arm.options,
        posthogTransportFactory: spy.factory,
        identity,
      })

      expect(composed.transport).toBeUndefined()
      expect(composed.transportKind).toBe('none')
      expect(composed.optedOut).toBe(arm.optedOut)

      composed.port.capture({ name: 'agent-qa.probe', properties: {} })
      await expect(composed.port.flush()).resolves.toBeUndefined()
      await expect(composed.port.shutdown()).resolves.toBeUndefined()

      expect(spy.calls).toEqual([])
      expect(identity).not.toHaveBeenCalled()
    }
  })
})
