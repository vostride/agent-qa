import { describe, expect, it, vi } from 'vitest'

import { findDeviceHere } from '@vostride/agent-qa-core'
import type { AndroidHere, ResolvedMobileRunConfig } from '@vostride/agent-qa-core'

import { listDevicesHereOncePerRun, prepareMobileDevice } from '../run.js'

const LISTING: AndroidHere = {
  attached: [],
  avds: [{ name: 'Pixel_8_API_35', profile: 'pixel_8', displayName: 'Pixel 8', os: '15' }],
}

function hereDevice(model: string): ResolvedMobileRunConfig {
  return {
    platform: 'android',
    targetName: 'shop-android',
    deviceName: 'pixel',
    device: { name: 'pixel', platform: 'android', model },
    plan: { kind: 'here', search: { model } },
    app: { appPackage: 'com.example.shop', sourceTrace: {} },
    appState: 'preserve',
    appium: {},
    sourceTrace: [],
  }
}

function remoteDevice(): ResolvedMobileRunConfig {
  const remote = {
    name: 'farm',
    protocol: 'appium' as const,
    url: 'https://farm.example.com/wd/hub',
    connectTimeoutMs: 300_000,
  }
  return {
    ...hereDevice('Samsung Galaxy S24'),
    deviceName: 'galaxy-farm',
    device: { name: 'galaxy-farm', platform: 'android', model: 'Samsung Galaxy S24', remote },
    plan: { kind: 'remote', remote },
  }
}

function doors(options: { host?: string } = {}) {
  const calls: string[] = []
  const listDevicesHere = vi.fn(async (platform: 'android' | 'ios') => {
    calls.push(`list ${platform}`)
    return LISTING
  })
  const hostAppiumUrl = vi.fn(() => {
    calls.push('host')
    return options.host
  })
  const startAppium = vi.fn(async () => {
    calls.push('start')
    return 'http://127.0.0.1:4723'
  })
  return { calls, listDevicesHere, hostAppiumUrl, startAppium }
}

describe('preparing a mobile member for its session', () => {
  it('asks for no listing and no Appium for a device on a remote', async () => {
    const { calls, listDevicesHere, hostAppiumUrl, startAppium } = doors({
      host: 'http://127.0.0.1:4800',
    })

    const prepared = await prepareMobileDevice({
      resolved: remoteDevice(),
      envUrl: 'http://127.0.0.1:4723',
      hostAppiumUrl,
      startAppium,
      listDevicesHere,
    })

    expect(prepared.remote?.name).toBe('farm')
    expect(prepared.appiumUrl).toBeUndefined()
    expect(prepared.managed).toBe(false)
    expect(calls).toEqual([])
  })

  it('finds an AVD here before Appium starts, hands it over and starts Appium once', async () => {
    const { calls, listDevicesHere, hostAppiumUrl, startAppium } = doors()

    const prepared = await prepareMobileDevice({
      resolved: hereDevice('Pixel 8'),
      envUrl: undefined,
      hostAppiumUrl,
      startAppium,
      listDevicesHere,
    })

    expect(prepared.here?.avd).toBe('Pixel_8_API_35')
    expect(prepared.here?.udid).toBeUndefined()
    expect(prepared.appiumUrl).toBe('http://127.0.0.1:4723')
    expect(prepared.managed).toBe(true)
    expect(calls).toEqual(['list android', 'host', 'start'])
  })

  it("refuses a device this machine lacks with the finder's sentence and asks for no Appium", async () => {
    const { calls, listDevicesHere, hostAppiumUrl, startAppium } = doors({
      host: 'http://127.0.0.1:4800',
    })
    const finder = findDeviceHere({
      device: 'pixel',
      platform: 'android',
      model: 'Pixel 9',
      android: LISTING,
    })
    expect('refusal' in finder).toBe(true)

    const prepared = prepareMobileDevice({
      resolved: hereDevice('Pixel 9'),
      envUrl: undefined,
      hostAppiumUrl,
      startAppium,
      listDevicesHere,
    })

    await expect(prepared).rejects.toMatchObject({
      name: 'RemoteRefusalError',
      message: 'refusal' in finder ? finder.refusal : '',
    })
    expect(calls).toEqual(['list android'])
  })

  it('uses a loopback AGENT_QA_APPIUM_URL and asks neither the host nor a start', async () => {
    const { calls, listDevicesHere, hostAppiumUrl, startAppium } = doors({
      host: 'http://127.0.0.1:4800',
    })

    const prepared = await prepareMobileDevice({
      resolved: hereDevice('Pixel 8'),
      envUrl: 'http://127.0.0.1:4724/wd/hub',
      hostAppiumUrl,
      startAppium,
      listDevicesHere,
    })

    expect(prepared.appiumUrl).toBe('http://127.0.0.1:4724/wd/hub')
    expect(prepared.managed).toBe(false)
    expect(prepared.here?.avd).toBe('Pixel_8_API_35')
    expect(calls).toEqual(['list android'])
  })

  it('refuses an AGENT_QA_APPIUM_URL that is not this machine and starts no Appium', async () => {
    const { calls, listDevicesHere, hostAppiumUrl, startAppium } = doors()

    const prepared = prepareMobileDevice({
      resolved: hereDevice('Pixel 8'),
      envUrl: 'https://farm.example.com/wd/hub',
      hostAppiumUrl,
      startAppium,
      listDevicesHere,
    })

    await expect(prepared).rejects.toMatchObject({
      name: 'RemoteRefusalError',
      message:
        'AGENT_QA_APPIUM_URL names farm.example.com, which is not this machine. List that server ' +
        "under registry.remotes with protocol: appium and set the device's remote to its name.",
    })
    expect(calls).toEqual(['list android'])
  })

  it("uses the host's Appium before starting one", async () => {
    const { calls, listDevicesHere, hostAppiumUrl, startAppium } = doors({
      host: 'http://127.0.0.1:4800',
    })

    const prepared = await prepareMobileDevice({
      resolved: hereDevice('Pixel 8'),
      envUrl: undefined,
      hostAppiumUrl,
      startAppium,
      listDevicesHere,
    })

    expect(prepared.appiumUrl).toBe('http://127.0.0.1:4800')
    expect(prepared.managed).toBe(false)
    expect(calls).toEqual(['list android', 'host'])
  })

  it('reads the listing once for two members on one platform in a run', async () => {
    const { listDevicesHere, hostAppiumUrl, startAppium } = doors({
      host: 'http://127.0.0.1:4800',
    })
    const onceThisRun = listDevicesHereOncePerRun(listDevicesHere)
    const member = () =>
      prepareMobileDevice({
        resolved: hereDevice('Pixel 8'),
        envUrl: undefined,
        hostAppiumUrl,
        startAppium,
        listDevicesHere: onceThisRun,
      })

    await member()
    await member()

    expect(listDevicesHere).toHaveBeenCalledTimes(1)
    expect(listDevicesHere).toHaveBeenCalledWith('android')
  })
})
