import { describe, expect, it } from 'vitest'

import { chooseAppiumEndpoint } from '../appium-endpoint.js'

const here = { name: 'pixel' }

describe('chooseAppiumEndpoint', () => {
  it('uses a device remote and ignores AGENT_QA_APPIUM_URL', () => {
    expect(
      chooseAppiumEndpoint({
        device: { name: 'galaxy-farm', remote: 'farm' },
        envUrl: 'http://127.0.0.1:4723',
      }),
    ).toEqual({ kind: 'remote' })
  })

  it('leaves a device here to the host or a started Appium when the variable is unset', () => {
    expect(chooseAppiumEndpoint({ device: here })).toEqual({ kind: 'host-or-start' })
    expect(chooseAppiumEndpoint({ device: here, envUrl: '  ' })).toEqual({ kind: 'host-or-start' })
  })

  it('takes a loopback AGENT_QA_APPIUM_URL with its port and path', () => {
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'http://127.0.0.1:4723/wd/hub' })).toEqual({
      kind: 'given',
      url: 'http://127.0.0.1:4723/wd/hub',
    })
  })

  it('writes in the port the scheme implies', () => {
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'https://localhost/' })).toEqual({
      kind: 'given',
      url: 'https://localhost:443/',
    })
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'http://LOCALHOST' })).toEqual({
      kind: 'given',
      url: 'http://localhost:80/',
    })
  })

  it('takes the IPv6 loopback', () => {
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'http://[::1]:4723' })).toEqual({
      kind: 'given',
      url: 'http://[::1]:4723/',
    })
  })

  it('refuses a host that is not this machine', () => {
    expect(
      chooseAppiumEndpoint({ device: here, envUrl: 'https://farm.example.com/wd/hub' }),
    ).toEqual({
      refusal:
        "AGENT_QA_APPIUM_URL names farm.example.com, which is not this machine. List that server under registry.remotes with protocol: appium and set the device's remote to its name.",
    })
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'http://0.0.0.0:4723' })).toHaveProperty(
      'refusal',
    )
  })

  it('refuses a user, password or query', () => {
    const refusal = {
      refusal:
        'AGENT_QA_APPIUM_URL must not carry a user, password or query; it names your own Appium on this machine.',
    }
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'http://qa:key@127.0.0.1:4723' })).toEqual(
      refusal,
    )
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'http://qa@localhost:4723' })).toEqual(
      refusal,
    )
    expect(
      chooseAppiumEndpoint({ device: here, envUrl: 'http://127.0.0.1:4723/wd/hub?token=x' }),
    ).toEqual(refusal)
  })

  it('refuses a scheme other than http or https', () => {
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'ftp://127.0.0.1:4723' })).toEqual({
      refusal: 'AGENT_QA_APPIUM_URL must start with http:// or https://.',
    })
  })

  it('refuses a value that is not a URL', () => {
    expect(chooseAppiumEndpoint({ device: here, envUrl: '127.0.0.1:4723' })).toHaveProperty(
      'refusal',
    )
    expect(chooseAppiumEndpoint({ device: here, envUrl: 'http://' })).toEqual({
      refusal:
        'AGENT_QA_APPIUM_URL is not a URL; set it to your Appium on this machine, for example http://127.0.0.1:4723.',
    })
  })
})
