import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import {
  createRemoteRefusalMemory,
  createRemoteSessionRegistry,
  RemoteRefusalError,
} from '@vostride/agent-qa-runner'
import type {
  RemoteLease,
  RemoteLeaseAnswer,
  RemoteLeaseEnded,
  RemoteLeaseRequest,
  RemoteLeaseSource,
  RemotePluginBrowserConfig,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { MIN_PLUGIN_CONNECT_MS, WebPlatformAdapter } from '../adapter.js'
import type { WebPlatformAdapterOptions } from '../adapter.js'
import { freePort, startPlaywrightServer } from './fixtures/remote-browsers.js'

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

interface FakeLeases {
  readonly source: RemoteLeaseSource
  readonly requests: RemoteLeaseRequest[]
  readonly release: Mock<() => Promise<void>>
  readonly started: Mock<RemoteLease['started']>
  readonly leases: RemoteLease[]
  readonly listeners: Set<(ended: RemoteLeaseEnded) => void>
  end(ended: RemoteLeaseEnded): void
}

function fakeLeases(answer: RemoteLeaseAnswer, delayMs = 0): FakeLeases {
  const requests: RemoteLeaseRequest[] = []
  const leases: RemoteLease[] = []
  const release = vi.fn<() => Promise<void>>(() => Promise.resolve())
  const started = vi.fn<RemoteLease['started']>(() => Promise.resolve({}))
  const listeners = new Set<(ended: RemoteLeaseEnded) => void>()
  const source: RemoteLeaseSource = {
    async acquire(request) {
      requests.push(request)
      if (delayMs > 0) await new Promise((wait) => setTimeout(wait, delayMs))
      const lease: RemoteLease = {
        connection: answer,
        plugin: {
          entry: 'lab',
          path: './tools/lab',
          version: '1.0.0',
          protocol: 1,
          origin: 'path',
        },
        started,
        end: () => Promise.resolve(),
        release,
        onEnded(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
      leases.push(lease)
      return lease
    },
  }
  const end = (ended: RemoteLeaseEnded) => {
    for (const listener of [...listeners]) listener(ended)
  }
  return { source, requests, release, started, leases, listeners, end }
}

function pluginRemote(connectTimeoutMs = 30_000): RemotePluginBrowserConfig {
  return { name: 'lab-chrome', plugin: { entry: 'lab' }, connectTimeoutMs }
}

async function setupOn(
  remote: RemotePluginBrowserConfig,
  options: WebPlatformAdapterOptions,
): Promise<WebPlatformAdapter> {
  const adapter = new WebPlatformAdapter(options)
  teardowns.push(() => adapter.cleanup())
  await adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } })
  return adapter
}

async function refusalOf(
  remote: RemotePluginBrowserConfig,
  options: WebPlatformAdapterOptions,
): Promise<RemoteRefusalError> {
  const error = await setupOn(remote, options).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(RemoteRefusalError)
  return error as RemoteRefusalError
}

// Playwright's connect has an overload whose second argument holds the timeout.
function connectTimeout(call: readonly unknown[] | undefined): number | undefined {
  return (call?.[1] as { timeout?: number } | undefined)?.timeout
}

async function closedAnswer(): Promise<{ answer: RemoteLeaseAnswer; port: number }> {
  const port = await freePort()
  return { answer: { protocol: 'playwright', url: `ws://127.0.0.1:${String(port)}/lab` }, port }
}

describe("a plugin remote's leased session", () => {
  it('releases the lease once when the answered server does not take the connect', async () => {
    const { answer, port } = await closedAnswer()
    const leases = fakeLeases(answer)
    const adapter = new WebPlatformAdapter({ pluginSessions: leases.source })

    const error = await adapter
      .setup({ platform: 'web', browser: { name: 'chromium', remote: pluginRemote() } })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

    expect(error).toBeInstanceOf(RemoteRefusalError)
    expect((error as RemoteRefusalError).kind).toBe('unreachable')
    expect((error as RemoteRefusalError).message).toBe(
      `Remote lab-chrome (playwright ws://127.0.0.1:${String(port)}) did not answer. Check its url and that the service is running.`,
    )
    expect(leases.release).toHaveBeenCalledTimes(1)
    await adapter.cleanup()
    expect(leases.release).toHaveBeenCalledTimes(1)
    expect(leases.started).not.toHaveBeenCalled()
  })

  it('asks the plugin for a web session with the deadline the remote allows', async () => {
    const { answer } = await closedAnswer()
    const leases = fakeLeases(answer)

    await refusalOf({ ...pluginRemote(4_000), context: 'new' }, { pluginSessions: leases.source })

    expect(leases.requests).toEqual([
      {
        remote: 'lab-chrome',
        plugin: { entry: 'lab' },
        deadlineMs: 4_000,
        session: { platform: 'web', engine: 'chromium', context: 'new' },
      },
    ])
  })

  it("leaves the connect only what the acquire did not spend of the remote's budget", async () => {
    const { answer } = await closedAnswer()
    const connect = vi.spyOn(chromium, 'connect')

    await refusalOf(pluginRemote(3_000), { pluginSessions: fakeLeases(answer, 300).source })

    const timeout = connectTimeout(connect.mock.calls[0])
    expect(timeout).toBeLessThanOrEqual(2_700)
    expect(timeout).toBeGreaterThan(2_000)
  })

  it('still gives the connect a floor when the acquire spent nearly all of the budget', async () => {
    const { answer } = await closedAnswer()
    const connect = vi.spyOn(chromium, 'connect')

    await refusalOf(pluginRemote(1_000), { pluginSessions: fakeLeases(answer, 300).source })

    const timeout = connectTimeout(connect.mock.calls[0])
    expect(timeout).toBe(MIN_PLUGIN_CONNECT_MS)
  })

  it('closes the browser and then releases the lease when the session registry releases it', async () => {
    const server = await startPlaywrightServer()
    teardowns.push(() => server.close())
    const leases = fakeLeases({ protocol: 'playwright', url: server.wsEndpoint })
    const events: string[] = []
    leases.release.mockImplementation(() => {
      events.push('released')
      return Promise.resolve()
    })
    const connect = chromium.connect.bind(chromium)
    let browser: Browser | undefined
    vi.spyOn(chromium, 'connect').mockImplementation(async (...args) => {
      browser = await connect(...args)
      browser.on('disconnected', () => events.push('closed'))
      return browser
    })
    const sessions = createRemoteSessionRegistry()

    const adapter = await setupOn(pluginRemote(), { pluginSessions: leases.source, sessions })

    expect(adapter.remoteLease).toBe(leases.leases[0])
    expect(leases.started).toHaveBeenCalledTimes(1)
    expect(adapter.placeEvidence).toMatchObject({ place: 'remote', name: 'lab-chrome' })
    await sessions.releaseAll(2_000)
    expect(events).toEqual(['closed', 'released'])

    await adapter.cleanup()
    expect(leases.release).toHaveBeenCalledTimes(1)
    expect(adapter.remoteLease).toBeUndefined()
  })

  it('releases the lease after the browser closes at cleanup', async () => {
    const server = await startPlaywrightServer()
    teardowns.push(() => server.close())
    const leases = fakeLeases({ protocol: 'playwright', url: server.wsEndpoint })
    let connectedAtRelease: boolean | undefined
    let browser: Browser | undefined
    const connect = chromium.connect.bind(chromium)
    vi.spyOn(chromium, 'connect').mockImplementation(async (...args) => {
      browser = await connect(...args)
      return browser
    })
    leases.release.mockImplementation(() => {
      connectedAtRelease = browser?.isConnected()
      return Promise.resolve()
    })

    const adapter = await setupOn(pluginRemote(), { pluginSessions: leases.source })
    await adapter.cleanup()

    expect(leases.release).toHaveBeenCalledTimes(1)
    expect(connectedAtRelease).toBe(false)
  })

  it('ends the test as lost, naming the remote, when the plugin that leased it stops', async () => {
    const server = await startPlaywrightServer()
    teardowns.push(() => server.close())
    const leases = fakeLeases({ protocol: 'playwright', url: server.wsEndpoint })
    const connect = vi.spyOn(chromium, 'connect')
    const adapter = await setupOn(pluginRemote(), { pluginSessions: leases.source })
    const browser = (await connect.mock.results[0]?.value) as Browser
    expect(adapter.isBrowserDisconnected).toBe(false)
    expect(leases.listeners.size).toBe(1)

    const message = 'Remote lab-chrome: plugin entry lab stopped unexpectedly.'
    leases.end({ kind: 'lost', message })

    expect(adapter.isBrowserDisconnected).toBe(true)
    expect(adapter.disconnectSummary).toBe(message)
    expect(adapter.placeEvidence).toMatchObject({
      place: 'remote',
      name: 'lab-chrome',
      failureKind: 'lost',
    })
    await vi.waitFor(() => expect(browser.isConnected()).toBe(false))
    await adapter.settleDisconnect()
    expect(adapter.disconnectSummary).toBe(message)
    const step = await adapter.execute({ type: 'navigate', to: 'url', url: 'about:blank' }).then(
      (result) => result.success,
      () => false,
    )
    expect(step).toBe(false)

    await adapter.cleanup()
    expect(leases.listeners.size).toBe(0)
    expect(leases.release).toHaveBeenCalledTimes(1)
  })

  it('refuses a remote whose plugin had no free session from memory, without asking again', async () => {
    const acquire = vi.fn<RemoteLeaseSource['acquire']>(() =>
      Promise.reject(
        new RemoteRefusalError('Remote lab-chrome: no free session.', {
          remote: 'lab-chrome',
          kind: 'capacity',
        }),
      ),
    )
    const options = { pluginSessions: { acquire }, refusalMemory: createRemoteRefusalMemory() }

    const first = await refusalOf(pluginRemote(), options)
    const second = await refusalOf(pluginRemote(), options)

    for (const error of [first, second]) {
      expect(error.kind).toBe('capacity')
      expect(error.message).toBe('Remote lab-chrome: no free session.')
    }
    expect(acquire).toHaveBeenCalledTimes(1)
  })
})
