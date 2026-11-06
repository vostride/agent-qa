import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { rememberedDeviceRefusal } from '@vostride/agent-qa-core'
import type { AgentQaConfig, DevicePlace } from '@vostride/agent-qa-core'
import type { PluginServe } from '@vostride/agent-qa-plugin-kit/protocol'
import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'
import { createRemoteRefusalMemory, RemoteRefusalError } from '@vostride/agent-qa-runner'
import type { RemotePluginBrowserConfig, RemoteRefusalMemory } from '@vostride/agent-qa-runner'

import { rememberPluginRemoteRefusals, webRefusalMemory } from '../plugin-remote-refusals.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const PLUGIN = { entry: 'kit' }
const WEB_REMOTE: RemotePluginBrowserConfig = { name: 'farm', plugin: PLUGIN, connectTimeoutMs: 1 }
const PHONE: DevicePlace = {
  kind: 'remote',
  device: 'phone',
  remote: { name: 'farm', plugin: PLUGIN, connectTimeoutMs: 1, uploadTimeoutMs: 1 },
}

// One remote picked by a web test and by a device, its plugin serving what `serves` lists.
function remembered(serves: readonly PluginServe[] | 'missing'): RemoteRefusalMemory {
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-remote-refusals-')))
  roots.push(configDir)
  if (serves !== 'missing') writeScriptedPlugin(join(configDir, 'kit'), { serves })
  const memory = createRemoteRefusalMemory()
  rememberPluginRemoteRefusals({
    config: {
      registry: { remotes: [{ name: 'farm', plugin: 'kit' }] },
      plugins: [{ name: 'kit', path: './kit' }],
    } as unknown as AgentQaConfig,
    configDir,
    usedRemotes: [WEB_REMOTE],
    usedDevices: [PHONE],
    declaredSecrets: undefined,
    refusalMemory: memory,
  })
  return memory
}

describe('a plugin remote refused at run start', () => {
  it('refuses its web tests and not its device when the plugin serves only appium', () => {
    const memory = remembered(['appium'])

    expect(webRefusalMemory(memory).refusalFor('farm')?.message).toBe(
      'Remote farm cannot start: plugin entry kit serves appium, and a web test needs playwright '
        + 'or cdp.',
    )
    expect(rememberedDeviceRefusal(memory, { name: 'farm' }, 'phone')).toBeUndefined()
  })

  it('refuses its device and not its web tests when the plugin serves no appium', () => {
    const memory = remembered(['playwright'])

    expect(webRefusalMemory(memory).refusalFor('farm')).toBeUndefined()
    expect(rememberedDeviceRefusal(memory, { name: 'farm' }, 'phone')?.message).toBe(
      'Remote farm cannot start: plugin entry kit serves playwright, and a device needs appium.',
    )
  })

  it('refuses both its web tests and its device when its plugin cannot start at all', () => {
    const memory = remembered('missing')

    const web = webRefusalMemory(memory).refusalFor('farm')?.message
    expect(web).toMatch(/^Remote farm cannot start: /)
    expect(rememberedDeviceRefusal(memory, { name: 'farm' }, 'phone')?.message).toBe(web)
  })

  it('shares what a web test learns of the remote, such as its being unreachable', () => {
    const memory = createRemoteRefusalMemory()
    const unreachable = new RemoteRefusalError('Remote farm is unreachable.', {
      remote: 'farm',
      kind: 'unreachable',
    })

    webRefusalMemory(memory).remember('farm', unreachable)

    expect(rememberedDeviceRefusal(memory, { name: 'farm' }, 'phone')?.message).toBe(
      'Remote farm is unreachable.',
    )
  })
})
