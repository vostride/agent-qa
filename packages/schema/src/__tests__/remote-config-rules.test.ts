import { describe, expect, it } from 'vitest'

import {
  closedConfigFieldsChanged,
  connectionSecretNames,
  formatRemoteOrigin,
  isLoopbackHost,
  remoteLabel,
  remoteOrigin,
  secretReferenceNames,
  SUBSCRIPTION_AUTH_PACKAGE,
} from '../config/remote'

describe('remote origin and label', () => {
  it('makes the default port explicit for each scheme', () => {
    expect(remoteOrigin('ws://grid.example.com')).toEqual({
      scheme: 'ws',
      host: 'grid.example.com',
      port: 80,
    })
    expect(remoteOrigin('wss://grid.example.com/x')).toEqual({
      scheme: 'wss',
      host: 'grid.example.com',
      port: 443,
    })
    expect(remoteOrigin('http://grid.example.com')?.port).toBe(80)
    expect(remoteOrigin('https://grid.example.com')?.port).toBe(443)
  })

  it('keeps an explicit port', () => {
    expect(remoteOrigin('ws://grid.example.com:3000/pw')?.port).toBe(3000)
  })

  it('returns undefined for a url that does not parse', () => {
    expect(remoteOrigin('not a url')).toBeUndefined()
  })

  it('writes an IPv6 host in brackets', () => {
    const origin = remoteOrigin('ws://[::1]:9222/devtools')
    expect(origin).toEqual({ scheme: 'ws', host: '::1', port: 9222 })
    expect(formatRemoteOrigin(origin!)).toBe('ws://[::1]:9222')
  })

  it('labels a remote by name, protocol and origin, never its path or query', () => {
    const label = remoteLabel({
      name: 'grid',
      protocol: 'playwright',
      url: 'wss://grid.example.com/playwright?token={{secret:GRID_TOKEN}}',
    })
    expect(label).toBe('grid (playwright wss://grid.example.com:443)')
  })

  it('labels a remote whose url does not parse by name and protocol', () => {
    expect(remoteLabel({ name: 'grid', protocol: 'cdp', url: 'nowhere' })).toBe('grid (cdp)')
  })
})

describe('loopback hosts', () => {
  it('accepts localhost, the 127.0.0.0/8 range and ::1', () => {
    const hosts = [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '127.255.255.255',
      '::1',
      '[::1]',
    ]
    for (const host of hosts) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
  })

  it('refuses every other host', () => {
    const hosts = [
      'grid.example.com',
      '128.0.0.1',
      '10.0.0.1',
      '127.0.0.256',
      '::2',
      'localhost.example.com',
    ]
    for (const host of hosts) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})

describe('secret references', () => {
  it('reads every reference name in a text', () => {
    expect(secretReferenceNames('Bearer {{secret:A}} and {{secret:B_2}}')).toEqual(['A', 'B_2'])
    expect(secretReferenceNames('no reference here')).toEqual([])
  })

  it('collects every remote secret name from url, nested query, headers and basicAuth', () => {
    const names = connectionSecretNames([
      {
        name: 'grid',
        protocol: 'playwright',
        url: 'wss://grid.example.com/pw?session={{secret:URL_SECRET}}',
        query: { caps: { grid: { accessKey: '{{secret:NESTED_KEY}}' } }, plain: 'x' },
        headers: { 'x-api-token': '{{secret:HEADER_TOKEN}}' },
      },
      {
        name: 'debugger',
        protocol: 'cdp',
        url: 'https://cdp.example.com',
        basicAuth: { user: '{{secret:CDP_USER}}', password: '{{secret:CDP_PASSWORD}}' },
      },
    ])
    expect(names.sort()).toEqual(
      ['CDP_PASSWORD', 'CDP_USER', 'HEADER_TOKEN', 'NESTED_KEY', 'URL_SECRET'].sort(),
    )
  })

  it('names each secret once when several remotes share it', () => {
    const entry = {
      protocol: 'cdp',
      url: 'wss://cdp.example.com',
      headers: { token: '{{secret:T}}' },
    }
    expect(connectionSecretNames([{ ...entry, name: 'a' }, { ...entry, name: 'b' }])).toEqual(['T'])
  })
})

describe('closed config fields', () => {
  const grid = { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com/' }
  const subscription = { package: SUBSCRIPTION_AUTH_PACKAGE }

  it('an absent list or block counts as empty, and key order is not a change', () => {
    expect(closedConfigFieldsChanged(null, { registry: { remotes: [] }, plugins: { auth: null } }))
      .toBe(false)
    expect(closedConfigFieldsChanged(
      { registry: { remotes: [grid] } },
      { registry: { remotes: [{ url: grid.url, protocol: grid.protocol, name: grid.name }] } },
    )).toBe(false)
  })

  it('any change to the remotes or to plugins beside auth is a change', () => {
    expect(closedConfigFieldsChanged({}, { registry: { remotes: [grid] } })).toBe(true)
    expect(closedConfigFieldsChanged({ registry: { remotes: [grid] } }, { registry: {} })).toBe(true)
    expect(closedConfigFieldsChanged({}, { plugins: { providers: [] } })).toBe(true)
  })

  it('only one subscription-auth declaration appended at the end leaves auth open', () => {
    const local = { path: './auth.mjs' }
    expect(closedConfigFieldsChanged({}, { plugins: { auth: [subscription] } })).toBe(false)
    expect(closedConfigFieldsChanged(
      { plugins: { auth: [local] } },
      { plugins: { auth: [local, subscription] } },
    )).toBe(false)
    expect(closedConfigFieldsChanged(
      { plugins: { auth: [local] } },
      { plugins: { auth: [subscription, local] } },
    )).toBe(true)
    expect(closedConfigFieldsChanged({}, { plugins: { auth: [subscription, subscription] } }))
      .toBe(true)
    expect(closedConfigFieldsChanged({}, { plugins: { auth: [{ package: '@acme/auth' }] } }))
      .toBe(true)
    expect(closedConfigFieldsChanged({ plugins: { auth: [local] } }, { plugins: { auth: [] } }))
      .toBe(true)
  })
})
