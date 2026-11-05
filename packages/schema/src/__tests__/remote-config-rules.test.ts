import { describe, expect, it } from 'vitest'

import {
  appRefIssues,
  closedConfigFieldsChanged,
  configConnectionSecretNames,
  connectionSecretNames,
  formatRemoteOrigin,
  isLoopbackHost,
  remoteLabel,
  remoteEntryIssues,
  remoteOrigin,
  secretReferenceNames,
  SUBSCRIPTION_AUTH_PACKAGE,
  type RemoteEntryLike,
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

describe('an appium remote', () => {
  const farm: RemoteEntryLike = {
    name: 'farm',
    protocol: 'appium',
    url: 'https://farm.example.com/wd/hub',
    headers: { Authorization: 'Bearer {{secret:FARM_TOKEN}}' },
  }
  const noQuery =
    'Remote farm: an appium remote takes no query parameters; send credentials as headers or basicAuth.'

  function issues(entry: RemoteEntryLike): { path: string; message: string }[] {
    return remoteEntryIssues(entry).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
  }

  it('takes an https url with headers and capabilities whose credentials are references', () => {
    expect(
      issues({ ...farm, capabilities: { 'farm:options': { accessKey: '{{secret:FARM_KEY}}' } } }),
    ).toEqual([])
  })

  it('refuses query parameters, in query or in its url', () => {
    expect(issues({ ...farm, query: { region: 'eu' } })).toEqual([
      { path: 'query', message: noQuery },
    ])
    expect(issues({ ...farm, url: `${farm.url}?region=eu` })).toEqual([
      { path: 'url', message: noQuery },
    ])
  })

  it('refuses a context', () => {
    expect(issues({ ...farm, context: 'default' })).toEqual([
      { path: 'context', message: 'Remote farm: context applies to cdp remotes only.' },
    ])
  })

  it('refuses {{playwright:version}} in any of its values', () => {
    const sentence =
      'Remote farm: {{playwright:version}} applies to playwright and cdp remotes only.'
    expect(issues({ ...farm, headers: { 'X-Client': 'pw-{{playwright:version}}' } })).toEqual([
      { path: 'headers', message: sentence },
    ])
    expect(
      issues({ ...farm, capabilities: { 'farm:options': { client: '{{playwright:version}}' } } }),
    ).toEqual([{ path: 'capabilities', message: sentence }])
    expect(
      issues({
        ...farm,
        headers: undefined,
        basicAuth: { user: '{{playwright:version}}', password: '{{secret:FARM_PASSWORD}}' },
      }),
    ).toEqual([{ path: 'basicAuth', message: sentence }])
  })

  it('refuses a literal under a credential name in its capabilities', () => {
    expect(issues({ ...farm, capabilities: { 'farm:options': { accessKey: 'literal' } } })).toEqual(
      [
        {
          path: 'capabilities.farm:options.accessKey',
          message:
            'Remote farm: capabilities "farm:options.accessKey" names a credential, so its value must be a {{secret:NAME}} reference.',
        },
      ],
    )
  })

  it('sends capability credentials over http:// only to this machine', () => {
    const capabilities = { 'farm:options': { accessKey: '{{secret:FARM_KEY}}' } }
    expect(
      issues({ ...farm, headers: undefined, url: 'http://farm.example.com/wd/hub', capabilities }),
    ).toEqual([
      {
        path: 'url',
        message:
          'Remote farm: credentials go over http:// only to this machine. Use https:// for farm.example.com.',
      },
    ])
    expect(
      issues({ ...farm, headers: undefined, url: 'http://127.0.0.1:4723', capabilities }),
    ).toEqual([])
  })

  it('a playwright or cdp remote takes no capabilities', () => {
    for (const protocol of ['playwright', 'cdp']) {
      expect(
        issues({
          name: 'grid',
          protocol,
          url: 'wss://grid.example.com/session',
          capabilities: { browserName: 'chromium' },
        }),
      ).toEqual([
        {
          path: 'capabilities',
          message: 'Remote grid: capabilities apply to appium remotes only.',
        },
      ])
    }
  })
})

describe('an app reference', () => {
  const at = ['registry', 'targets', 'shop', 'app', 'ref']

  function messages(ref: string): string[] {
    return appRefIssues(ref, at).map((issue) => issue.message)
  }

  it('refuses a user name or password in an http(s) url, at the ref', () => {
    expect(appRefIssues('https://qa:hunter2@files.example.com/shop.apk', at)).toEqual([
      {
        path: at,
        message:
          'app.ref carries a user name or password. Send credentials as {{secret:NAME}} references in its query.',
      },
    ])
  })

  it('refuses a literal under a credential-named query key, such as a presigned signature', () => {
    expect(
      messages('https://files.example.com/shop.apk?X-Amz-Expires=600&X-Amz-Signature=9f3e1a'),
    ).toEqual([
      'app.ref query "X-Amz-Signature" names a credential, so its value must be a {{secret:NAME}} reference.',
    ])
  })

  it('takes a reference over https', () => {
    expect(
      messages('https://files.example.com/shop.apk?X-Amz-Signature={{secret:SHOP_APK_SIGNATURE}}'),
    ).toEqual([])
  })

  it('sends a reference over http:// only to this machine', () => {
    expect(messages('http://files.example.com/shop.apk?token={{secret:SHOP_TOKEN}}')).toEqual([
      'credentials in app.ref go over http:// only to this machine. Use https:// for files.example.com.',
    ])
    expect(messages('http://localhost:8080/shop.apk?token={{secret:SHOP_TOKEN}}')).toEqual([])
  })

  it("takes a server's own reference, bare or as a reference, as written", () => {
    expect(messages('farm://a1b2c3d4')).toEqual([])
    expect(messages('{{secret:SHOP_APP_REF}}')).toEqual([])
  })
})

describe('connection-only secret names across the config', () => {
  it('names the secrets in remotes, device capabilities and target app references, sorted and once each', () => {
    const config = {
      registry: {
        remotes: [
          {
            name: 'farm',
            protocol: 'appium',
            url: 'https://farm.example.com/wd/hub',
            headers: { Authorization: 'Bearer {{secret:FARM_TOKEN}}' },
            capabilities: { 'farm:options': { project: '{{secret:FARM_PROJECT}}' } },
          },
        ],
        devices: {
          'galaxy-farm': {
            platform: 'android',
            remote: 'farm',
            capabilities: {
              'farm:options': { accessKey: '{{secret:FARM_KEY}}', team: '{{secret:FARM_TOKEN}}' },
            },
          },
          pixel: { platform: 'android', model: 'Pixel 9' },
        },
        targets: {
          shop: {
            platform: 'android',
            app: { ref: 'https://files.example.com/shop.apk?sig={{secret:SHOP_APK_SIGNATURE}}' },
          },
          web: { platform: 'web', url: 'https://shop.example.com/{{secret:NOT_CONNECTION}}' },
        },
      },
    }
    expect(configConnectionSecretNames(config)).toEqual([
      'FARM_KEY',
      'FARM_PROJECT',
      'FARM_TOKEN',
      'SHOP_APK_SIGNATURE',
    ])
    expect(configConnectionSecretNames({})).toEqual([])
  })
})

describe('closed config fields', () => {
  const grid = { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com/' }
  const subscription = { name: 'subscription', package: SUBSCRIPTION_AUTH_PACKAGE }

  it('an absent list or block counts as empty, and key order is not a change', () => {
    expect(closedConfigFieldsChanged(null, { registry: { remotes: [] }, plugins: [] })).toBe(false)
    expect(closedConfigFieldsChanged(
      { registry: { remotes: [grid] } },
      { registry: { remotes: [{ url: grid.url, protocol: grid.protocol, name: grid.name }] } },
    )).toBe(false)
  })

  it('any change to the remotes is a change', () => {
    expect(closedConfigFieldsChanged({}, { registry: { remotes: [grid] } })).toBe(true)
    expect(closedConfigFieldsChanged({ registry: { remotes: [grid] } }, { registry: {} })).toBe(true)
  })

  it("a device's remote or capabilities and a target's app reference are closed, a local device's other fields are not", () => {
    const pixel = { platform: 'android', model: 'Pixel 9', os: '15' }
    const galaxy = { platform: 'android', remote: 'farm', capabilities: { 'appium:noReset': true } }
    const shop = { platform: 'android', app: { path: 'apps/shop.apk', ref: 'https://f.example/a' } }
    const config = { registry: { devices: { pixel, 'galaxy-farm': galaxy }, targets: { shop } } }
    const withRegistry = (registry: Record<string, unknown>) => ({
      registry: { ...config.registry, ...registry },
    })
    const devices = (next: Record<string, unknown>) => withRegistry({ devices: next })

    for (const changed of [
      devices({ pixel: { ...pixel, remote: 'farm' }, 'galaxy-farm': galaxy }),
      devices({ pixel: { ...pixel, capabilities: {} }, 'galaxy-farm': galaxy }),
      devices({ pixel, 'galaxy-farm': { ...galaxy, remote: 'other' } }),
      devices({ pixel, 'galaxy-farm': { ...galaxy, capabilities: { 'appium:noReset': false } } }),
      devices({ pixel, 'galaxy-farm': { platform: 'android', remote: 'farm' } }),
      devices({ pixel }),
      devices({ pixel, 'galaxy-two': galaxy }),
      withRegistry({
        targets: { shop: { ...shop, app: { ...shop.app, ref: 'https://e.example/a' } } },
      }),
      withRegistry({ targets: { shop: { ...shop, app: { path: 'apps/shop.apk' } } } }),
      withRegistry({ targets: { other: shop } }),
    ]) {
      expect({ changed, closed: closedConfigFieldsChanged(config, changed) }).toEqual({
        changed,
        closed: true,
      })
    }
    for (const open of [
      devices({
        pixel: { ...pixel, model: 'Pixel 9 Pro', os: '16', id: 'emulator-5554' },
        'galaxy-farm': galaxy,
      }),
      devices({ 'galaxy-farm': { ...galaxy, model: 'Galaxy S24' } }),
      devices({ 'galaxy-farm': galaxy, pixel2: pixel }),
      withRegistry({
        targets: { shop: { ...shop, app: { ...shop.app, path: 'apps/shop-2.apk' } } },
      }),
    ]) {
      expect({ open, closed: closedConfigFieldsChanged(config, open) }).toEqual({
        open,
        closed: false,
      })
    }
  })

  it('appending the one subscription entry is the only change plugins allows', () => {
    const local = { name: 'local', path: './plugins/local' }
    for (const [before, after] of [
      [{ plugins: [] }, { plugins: [subscription] }],
      [{}, { plugins: [subscription] }],
      [{ plugins: [local] }, { plugins: [local, subscription] }],
    ]) {
      expect({ before, after, closed: closedConfigFieldsChanged(before, after) }).toEqual({
        before,
        after,
        closed: false,
      })
    }
    for (const [before, after] of [
      [{}, { plugins: [{ name: 'subscription', package: '@acme/auth' }] }],
      [{}, { plugins: [{ name: 'sign-in', package: SUBSCRIPTION_AUTH_PACKAGE }] }],
      [{}, { plugins: [{ ...subscription, options: { region: 'eu' } }] }],
      [{ plugins: [local] }, { plugins: [subscription, local] }],
      [{}, { plugins: [subscription, subscription] }],
      [{ plugins: [local] }, { plugins: [] }],
      [{ plugins: [local] }, { plugins: [{ ...local, path: './plugins/other' }] }],
    ]) {
      expect({ before, after, closed: closedConfigFieldsChanged(before, after) }).toEqual({
        before,
        after,
        closed: true,
      })
    }
  })
})
