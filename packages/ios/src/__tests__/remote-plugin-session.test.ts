import { RemoteRefusalError } from '@vostride/agent-qa-runner'
import type { RemotePluginDeviceConfig } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import { IOSPlatformAdapter } from '../adapter.js'
import { createIOSSession } from '../session.js'
import type { IOSAdapterConfig } from '../types.js'

interface FakeAppiumServer {
  readonly url: string
  readonly requests: readonly unknown[]
  close(): Promise<void>
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as { startFakeAppiumServer: () => Promise<FakeAppiumServer> }

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

const REFUSAL =
  'Device iphone-stack is on remote stack, a plugin remote, and iOS devices run only on url remotes; give this device a url remote with protocol: appium.'

function deviceOnPlugin(appiumUrl: string): IOSAdapterConfig {
  const remote: RemotePluginDeviceConfig = {
    name: 'stack',
    plugin: { entry: 'stack' },
    connectTimeoutMs: 30_000,
    uploadTimeoutMs: 600_000,
  }
  return {
    platform: 'ios',
    targetName: 'shop-ios',
    bundleId: 'com.example.shop',
    appiumUrl,
    device: { name: 'iphone-stack', platform: 'ios', model: 'iPhone 15', remote },
  }
}

async function refusalOf(work: Promise<unknown>): Promise<RemoteRefusalError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(RemoteRefusalError)
  return error as RemoteRefusalError
}

describe('an iOS device on a plugin remote', () => {
  it('is refused with one line, and no WebDriver request is sent', async () => {
    const server = await startFakeAppiumServer()
    teardowns.push(() => server.close())
    const adapter = new IOSPlatformAdapter()
    teardowns.push(() => adapter.cleanup())

    const error = await refusalOf(adapter.setup(deviceOnPlugin(server.url)))

    expect(error.message).toBe(REFUSAL)
    expect(error.kind).toBe('refused')
    expect(error.remote).toBe('stack')
    expect(adapter.placeEvidence).toBeUndefined()
    expect(server.requests).toHaveLength(0)
  })

  it('is refused by the session factory too', async () => {
    const server = await startFakeAppiumServer()
    teardowns.push(() => server.close())

    const error = await refusalOf(createIOSSession(deviceOnPlugin(server.url)))

    expect(error.message).toBe(REFUSAL)
    expect(server.requests).toHaveLength(0)
  })
})
