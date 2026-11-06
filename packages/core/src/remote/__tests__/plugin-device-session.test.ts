import { RemoteRefusalError, SecretStore } from '@vostride/agent-qa-runner'
import type {
  RemoteLease,
  RemoteLeaseAnswer,
  RemoteLeaseSource,
  RemotePluginDeviceConfig,
} from '@vostride/agent-qa-runner'
import { describe, expect, it, vi } from 'vitest'

import type { CapabilityMap } from '../../mobile/device-plan.js'
import { createPluginDeviceSession } from '../plugin-device-session.js'
import type { RemoteDeviceConnection } from '../remote-device-connection.js'

const REMOTE: RemotePluginDeviceConfig = {
  name: 'farm',
  plugin: { entry: 'lab' },
  connectTimeoutMs: 30_000,
  uploadTimeoutMs: 30_000,
}

function leaseSource(
  answer: RemoteLeaseAnswer,
  release: () => Promise<void> = async () => undefined,
): RemoteLeaseSource {
  return {
    async acquire() {
      const lease: RemoteLease = {
        connection: answer,
        plugin: { entry: 'lab', version: '1.0.0', protocol: 1, origin: 'path' },
        started: async () => ({}),
        end: async () => undefined,
        beforeRelease: () => undefined,
        release,
        onEnded: () => () => undefined,
      }
      return lease
    },
  }
}

interface Opened {
  connection: RemoteDeviceConnection
  capabilities: CapabilityMap
}

async function openOn(
  answer: RemoteLeaseAnswer,
  options: {
    capabilities?: CapabilityMap
    secrets?: Record<string, string>
    release?: () => Promise<void>
  } = {},
): Promise<Opened> {
  const open = vi.fn(async (session: Opened) => session)
  const opened = await createPluginDeviceSession({
    platform: 'android',
    device: { name: 'pixel' },
    target: { name: 'shop' },
    appState: 'preserve',
    browserName: 'Chrome',
    derived: { platformName: 'Android' },
    remote: { ...REMOTE, ...(options.capabilities ? { capabilities: options.capabilities } : {}) },
    options: {
      pluginSessions: leaseSource(answer, options.release),
      connectionSecrets: new SecretStore(options.secrets ?? {}),
    },
    open,
  })
  return opened.driver
}

describe('a plugin device session', () => {
  it("sends the answer's capabilities as given and resolves only the stated ones", async () => {
    const opened = await openOn(
      {
        protocol: 'appium',
        url: 'https://hub.vendor.example/wd/hub',
        capabilities: { 'vendor:options': { note: '{{secret:PROJECT_TOKEN}}' } },
      },
      {
        capabilities: { 'vendor:user': '{{secret:FARM_USER}}' },
        secrets: { PROJECT_TOKEN: 'project-token-value', FARM_USER: 'farm-user-value' },
      },
    )

    expect(opened.capabilities).toMatchObject({
      platformName: 'Android',
      'vendor:options': { note: '{{secret:PROJECT_TOKEN}}' },
      'vendor:user': 'farm-user-value',
    })
    expect(JSON.stringify(opened.capabilities)).not.toContain('project-token-value')
  })

  it('opens when the answer names a secret the project does not declare', async () => {
    const opened = await openOn({
      protocol: 'appium',
      url: 'https://hub.vendor.example/wd/hub',
      capabilities: { 'vendor:options': { note: '{{secret:UNDECLARED}}' } },
    })

    expect(opened.capabilities['vendor:options']).toEqual({ note: '{{secret:UNDECLARED}}' })
  })

  it('puts the answer over the derived capabilities and under the remote and the device', async () => {
    const opened = await openOn(
      {
        protocol: 'appium',
        url: 'https://hub.vendor.example/wd/hub',
        capabilities: { platformName: 'android', 'vendor:a': 'answer', 'vendor:b': 'answer' },
      },
      { capabilities: { 'vendor:b': 'remote' } },
    )

    expect(opened.capabilities).toMatchObject({
      platformName: 'android',
      'vendor:a': 'answer',
      'vendor:b': 'remote',
    })
  })

  it("connects with the answer url's query and scheme", async () => {
    const opened = await openOn({
      protocol: 'appium',
      url: 'http://127.0.0.1:4723/wd/hub?token=t%2F1&region=eu',
    })

    expect(opened.connection).toEqual({
      protocol: 'http',
      hostname: '127.0.0.1',
      port: 4723,
      path: '/wd/hub',
      query: { token: 't/1', region: 'eu' },
      headers: {},
    })
  })

  it('refuses an answer url that is neither http nor https, and releases its lease', async () => {
    const release = vi.fn(async () => undefined)

    const refused = await openOn(
      { protocol: 'appium', url: 'ws://127.0.0.1:4723/wd/hub' },
      { release },
    ).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(RemoteRefusalError)
    expect((refused as Error).message).toBe(
      'Remote farm: plugin entry lab answered with a url that an appium connection cannot use.',
    )
    expect(release).toHaveBeenCalledTimes(1)
  })
})
