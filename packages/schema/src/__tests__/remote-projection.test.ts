import { describe, expect, it } from 'vitest'

import {
  configConnectionSecretNames,
  projectConfigRemotes,
  projectRemotesForDisplay,
  remoteLabel,
} from '../config/remote'

const PLANTED = {
  name: 'grid',
  protocol: 'playwright',
  url: 'wss://grid.example.com/p4th-t0ken/session?q=QUERY_SECRET#FRAGMENT',
  query: { tag: 'QUERY_VALUE' },
  headers: { 'X-Team': 'HEADER_VALUE' },
  basicAuth: { user: 'BASIC_USER', password: '{{secret:BASIC_PASS}}' },
}

const HIDDEN = [
  'p4th-t0ken',
  'session',
  'QUERY_SECRET',
  'FRAGMENT',
  'QUERY_VALUE',
  'X-Team',
  'HEADER_VALUE',
  'BASIC_USER',
  'BASIC_PASS',
]

describe('projectRemotesForDisplay', () => {
  it('shows a remote as its name, protocol and origin with an explicit port', () => {
    const shown = projectRemotesForDisplay([
      PLANTED,
      { name: 'local', protocol: 'cdp', url: 'http://127.0.0.1:9222/json/version' },
    ])

    expect(shown).toEqual([
      { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' },
      { name: 'local', protocol: 'cdp', url: 'http://127.0.0.1:9222' },
    ])
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows an unparseable url as invalid url', () => {
    expect(
      projectRemotesForDisplay([{ name: 'broken', protocol: 'cdp', url: 'not a url/p4th-t0ken' }]),
    ).toEqual([{ name: 'broken', protocol: 'cdp', url: 'invalid url' }])
  })
})

describe('projectConfigRemotes', () => {
  it('projects registry.remotes and keeps the rest of the config', () => {
    const config = {
      registry: {
        targets: { web: { platform: 'web', url: 'https://app.example.com/path' } },
        remotes: [PLANTED],
      },
      use: { remote: 'grid' },
    }

    const shown = projectConfigRemotes(config)

    expect(shown).toEqual({
      registry: {
        targets: { web: { platform: 'web', url: 'https://app.example.com/path' } },
        remotes: [{ name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }],
      },
      use: { remote: 'grid' },
    })
    expect(config.registry.remotes[0]).toBe(PLANTED)
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('returns a config without a remote list unchanged', () => {
    const config = { registry: { targets: {} } }

    expect(projectConfigRemotes(config)).toBe(config)
    expect(projectConfigRemotes(undefined)).toBeUndefined()
    expect(projectConfigRemotes('text')).toBe('text')
  })

  it('shows an entry that is not an object without any of its content', () => {
    const shown = projectConfigRemotes({
      registry: { remotes: ['wss://grid.example.com/p4th-t0ken'] },
    })

    expect(JSON.stringify(shown)).not.toContain('p4th-t0ken')
    expect(shown.registry.remotes).toEqual([{ url: 'invalid url' }])
  })

  it('shows a remotes block that is not a list as an empty list', () => {
    const shown = projectConfigRemotes({ registry: { remotes: { grid: PLANTED } } })

    expect(shown.registry.remotes).toEqual([])
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('hides a copy of a remote, of its list or of a part of it found elsewhere in the config', () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: [PLANTED],
        devices: {
          pixel: {
            capabilities: {
              'appium:avd': [PLANTED],
              'appium:serial': PLANTED,
              'appium:model': PLANTED.basicAuth,
            },
          },
          tablet: { capabilities: { 'appium:url': PLANTED.url } },
        },
      },
    })

    const grid = { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }
    expect(shown.registry.devices).toEqual({
      pixel: {
        capabilities: { 'appium:avd': [grid], 'appium:serial': grid, 'appium:model': null },
      },
      tablet: { capabilities: { 'appium:url': 'wss://grid.example.com:443' } },
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows a url copied from a remotes block that is not a list as its origin', () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: { grid: PLANTED },
        devices: {
          tablet: { capabilities: { 'appium:url': PLANTED.url, 'appium:serial': PLANTED.headers } },
        },
      },
    })

    expect(shown.registry).toEqual({
      remotes: [],
      devices: {
        tablet: {
          capabilities: { 'appium:url': 'wss://grid.example.com:443', 'appium:serial': null },
        },
      },
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows a name that is not a slug as invalid name and a protocol outside the allowed ones as invalid protocol, wherever they are copied', () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: [
          { name: PLANTED.url, protocol: 'playwright', url: 'wss://lab.example.com/' },
          { name: 'grid', protocol: PLANTED.headers, url: 'wss://grid.example.com/' },
          { name: 'grid.2', protocol: 'cdp', url: 'ws://127.0.0.1:9222/json' },
          { url: 'wss://grid.example.com/' },
        ],
        devices: {
          tablet: { capabilities: { 'appium:avd': PLANTED.url, 'appium:serial': PLANTED.headers } },
        },
      },
    })

    expect(shown.registry.remotes).toEqual([
      { name: 'invalid name', protocol: 'playwright', url: 'wss://lab.example.com:443' },
      { name: 'grid', protocol: 'invalid protocol', url: 'wss://grid.example.com:443' },
      { name: 'grid.2', protocol: 'cdp', url: 'ws://127.0.0.1:9222' },
      { url: 'wss://grid.example.com:443' },
    ])
    expect(shown.registry.devices).toEqual({
      tablet: { capabilities: { 'appium:avd': 'invalid name', 'appium:serial': null } },
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('hides what a remotes block that is an ordered map or a set, or an entry that is an ordered map, shares with the rest of the config', () => {
    const blocks: [unknown, unknown][] = [
      [new Map<string, unknown>([['grid', PLANTED]]), []],
      [new Set<unknown>([PLANTED.url, PLANTED.headers]), []],
      [
        [
          new Map<string, unknown>([
            ['name', 'grid'],
            ['url', PLANTED.url],
            ['headers', PLANTED.headers],
          ]),
        ],
        [{ url: 'invalid url' }],
      ],
    ]

    for (const [remotes, shownRemotes] of blocks) {
      const shown = projectConfigRemotes({
        registry: {
          remotes,
          devices: {
            tablet: {
              capabilities: { 'appium:url': PLANTED.url, 'appium:serial': PLANTED.headers },
            },
          },
        },
      })

      expect(shown.registry.remotes).toEqual(shownRemotes)
      expect(shown.registry.devices).toEqual({
        tablet: {
          capabilities: { 'appium:url': 'wss://grid.example.com:443', 'appium:serial': null },
        },
      })
      for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
    }
  })

  it("shows a remote's url as its origin where it is copied as a key, or where a url key of a block that is not a list is copied", () => {
    const asKey = projectConfigRemotes({
      registry: {
        remotes: [PLANTED],
        llms: [{ name: 'judge', providerHeaders: { [PLANTED.url]: 'x' } }],
      },
    })
    const urlKey = projectConfigRemotes({
      registry: {
        remotes: { [PLANTED.url]: 'grid' },
        devices: { tablet: { capabilities: { 'appium:url': PLANTED.url } } },
      },
    })
    const entryKeys = projectConfigRemotes({
      registry: {
        remotes: ['wss://grid.example.com/p4th-t0ken', 'grid-p4th-t0ken'],
        devices: {
          'wss://grid.example.com/p4th-t0ken': { platform: 'web' },
          'grid-p4th-t0ken': { platform: 'android' },
        },
      },
    })

    expect(asKey.registry.llms).toEqual([
      { name: 'judge', providerHeaders: { 'wss://grid.example.com:443': 'x' } },
    ])
    expect(urlKey.registry).toEqual({
      remotes: [],
      devices: { tablet: { capabilities: { 'appium:url': 'wss://grid.example.com:443' } } },
    })
    expect(entryKeys.registry.devices).toEqual({
      'wss://grid.example.com:443': { platform: 'web' },
      'invalid url': { platform: 'android' },
    })
    for (const shown of [asKey, urlKey, entryKeys]) {
      for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
    }
  })

  it('never renames a key written in the file, and numbers a copied url key that would take its name', () => {
    const origin = 'wss://grid.example.com:443'
    const headersOf = (providerHeaders: Record<string, string>): Record<string, string> => {
      const shown = projectConfigRemotes({
        registry: { remotes: [PLANTED], llms: [{ name: 'judge', providerHeaders }] },
      })
      for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
      return shown.registry.llms[0]!.providerHeaders
    }

    expect(
      headersOf({
        [origin]: 'written',
        [PLANTED.url]: 'copied',
        [`${origin} (2)`]: 'written second',
      }),
    ).toEqual({
      [origin]: 'written',
      [`${origin} (3)`]: 'copied',
      [`${origin} (2)`]: 'written second',
    })
    const copiedFirst = headersOf({ [PLANTED.url]: 'copied', [origin]: 'written' })
    expect(copiedFirst).toEqual({ [`${origin} (2)`]: 'copied', [origin]: 'written' })
    expect(Object.keys(copiedFirst)).toEqual([`${origin} (2)`, origin])
  })

  it('numbers the second of two copied url keys that share an origin', () => {
    const lab = {
      name: 'lab',
      protocol: 'playwright',
      url: 'wss://grid.example.com/second-p4th-t0ken?q=QUERY_SECRET',
    }
    const shown = projectConfigRemotes({
      registry: {
        remotes: [PLANTED, lab],
        llms: [{ name: 'judge', providerHeaders: { [PLANTED.url]: 'first', [lab.url]: 'second' } }],
      },
    })

    expect(shown.registry.llms).toEqual([
      {
        name: 'judge',
        providerHeaders: {
          'wss://grid.example.com:443': 'first',
          'wss://grid.example.com:443 (2)': 'second',
        },
      },
    ])
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('numbers a key copying an invalid name that would take the name of a written invalid name key', () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: [
          { name: 'Grid p4th-t0ken', protocol: 'playwright', url: 'wss://grid.example.com/' },
        ],
        devices: {
          'invalid name': { platform: 'web' },
          'Grid p4th-t0ken': { platform: 'android' },
        },
      },
    })

    expect(shown.registry.devices).toEqual({
      'invalid name': { platform: 'web' },
      'invalid name (2)': { platform: 'android' },
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it("shows a remote's url by its origin inside any text that holds it, a key yaml wrote from a collection included", () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: [
          { name: 'lab', protocol: 'playwright', url: 'wss://grid.example.com/p4th-t0ken' },
          PLANTED,
        ],
        llms: [
          {
            name: 'judge',
            providerHeaders: { [`[ &u ${PLANTED.url} ]`]: 'x', [`{ h: &u ${PLANTED.url} }`]: 'y' },
          },
        ],
        devices: {
          [`[ &u ${PLANTED.url} ]`]: {
            platform: 'android',
            capabilities: { 'appium:avd': `connects to ${PLANTED.url} for the pixel` },
          },
        },
      },
    })

    expect(shown.registry.llms).toEqual([
      {
        name: 'judge',
        providerHeaders: {
          '[ &u wss://grid.example.com:443 ]': 'x',
          '{ h: &u wss://grid.example.com:443 }': 'y',
        },
      },
    ])
    expect(shown.registry.devices).toEqual({
      '[ &u wss://grid.example.com:443 ]': {
        platform: 'android',
        capabilities: { 'appium:avd': 'connects to wss://grid.example.com:443 for the pixel' },
      },
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows a key yaml folded or escaped from a url whole as its origin when a shorter url of the block starts that url', () => {
    const tabbed = 'wss://grid.example.com/p4th-t0ken\tsession?q=QUERY_SECRET#FRAGMENT'
    const folded =
      '[\n  &u "wss://grid.example.com/p4th-t0ken/sess\\\n    ion?q=QUERY_SECRET#FRAGMENT"\n]'
    const escaped = '[ &u "wss://grid.example.com/p4th-t0ken\\tsession?q=QUERY_SECRET#FRAGMENT" ]'
    const shown = projectConfigRemotes({
      registry: {
        remotes: [
          PLANTED,
          { name: 'lab', protocol: 'playwright', url: tabbed },
          { name: 'edge', protocol: 'playwright', url: 'wss://grid.example.com/p4th-t0ken' },
        ],
        devices: {
          pixel: { capabilities: { 'appium:avd': { [folded]: 'folded', [escaped]: 'escaped' } } },
        },
      },
    })

    expect(shown.registry.devices.pixel.capabilities['appium:avd']).toEqual({
      'wss://grid.example.com:443': 'folded',
      'wss://grid.example.com:443 (2)': 'escaped',
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows a key that holds a url both as written and as yaml folds it whole as its origin when a shorter url of the block starts that url', () => {
    const both = `[\n  &a "wss://grid.example.com/p4th-t0ken/sess\\\n    ion?q=QUERY_SECRET#FRAGMENT",\n  &b ${PLANTED.url}\n]`
    const shown = projectConfigRemotes({
      registry: {
        remotes: [
          PLANTED,
          { name: 'edge', protocol: 'playwright', url: 'wss://grid.example.com/p4th-t0ken' },
        ],
        devices: { pixel: { capabilities: { 'appium:avd': { [both]: 'x' } } } },
      },
    })

    expect(shown.registry.devices.pixel.capabilities['appium:avd']).toEqual({
      'wss://grid.example.com:443': 'x',
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows a url the remotes block holds only inside a key yaml wrote from a collection by its origin where it is copied', () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: [
          {
            name: 'grid',
            protocol: 'playwright',
            url: 'wss://grid.example.com/',
            headers: { [`[ &u ${PLANTED.url} ]`]: 'v' },
          },
        ],
        devices: { tablet: { capabilities: { 'appium:avd': PLANTED.url } } },
      },
    })

    expect(shown.registry.devices).toEqual({
      tablet: { capabilities: { 'appium:avd': 'wss://grid.example.com:443' } },
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows a url nested under another key of a list entry by its origin where it is copied', () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: [{ grid: PLANTED }],
        devices: {
          tablet: { capabilities: { 'appium:avd': PLANTED.url, 'appium:serial': PLANTED.headers } },
        },
      },
    })

    expect(shown.registry).toEqual({
      remotes: [{ url: 'invalid url' }],
      devices: {
        tablet: {
          capabilities: { 'appium:avd': 'wss://grid.example.com:443', 'appium:serial': null },
        },
      },
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('leaves every text of a config that holds no url of its remotes as it was', () => {
    const rest = {
      targets: { shop: { platform: 'web', url: 'https://grid.example.com/shop?team=blue' } },
      devices: {
        tablet: {
          capabilities: {
            'appium:avd': 'wss://edge.example.com/other',
            'appium:serial': 'http://127.0.0.1:9222/json/version',
          },
        },
      },
      llms: [
        {
          name: 'judge',
          providerHeaders: { 'X-Lane': 'grid', 'wss://grid.example.com/': 'bare' },
        },
      ],
    }
    const shown = projectConfigRemotes({
      registry: {
        ...rest,
        remotes: [
          PLANTED,
          { name: 'lab', protocol: 'cdp', url: 'http://127.0.0.1:9222' },
          { name: 'edge', protocol: 'playwright', url: 'wss://edge.example.com/' },
        ],
      },
      use: { browser: { name: 'chromium', remote: 'grid' } },
    })

    expect(shown).toEqual({
      registry: {
        ...rest,
        remotes: [
          { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' },
          { name: 'lab', protocol: 'cdp', url: 'http://127.0.0.1:9222' },
          { name: 'edge', protocol: 'playwright', url: 'wss://edge.example.com:443' },
        ],
      },
      use: { browser: { name: 'chromium', remote: 'grid' } },
    })
  })

  it('numbers a key whose url shows by its origin when a written key already holds that text', () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: [PLANTED],
        llms: [
          {
            name: 'judge',
            providerHeaders: {
              [`[ &u ${PLANTED.url} ]`]: 'copied',
              '[ &u wss://grid.example.com:443 ]': 'written',
            },
          },
        ],
      },
    })
    const headers = shown.registry.llms[0]!.providerHeaders

    expect(headers).toEqual({
      '[ &u wss://grid.example.com:443 ] (2)': 'copied',
      '[ &u wss://grid.example.com:443 ]': 'written',
    })
    expect(Object.keys(headers)).toEqual([
      '[ &u wss://grid.example.com:443 ] (2)',
      '[ &u wss://grid.example.com:443 ]',
    ])
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })
})

describe('a remote that names a plugins entry', () => {
  const CLOUD = {
    name: 'cloud',
    plugin: 'kernel',
    settings: { region: 'SETTING_VALUE', auth: { token: '{{secret:SETTING_TOKEN}}' } },
    connectTimeout: '45s',
    uploadTimeout: '15m',
    context: 'reuse',
    capabilities: { 'farm:options': { project: 'CAPABILITY_VALUE' } },
  }
  const SHOWN_NOWHERE = ['SETTING_VALUE', 'SETTING_TOKEN', '45s', '15m', 'reuse', 'CAPABILITY_VALUE']

  it('shows in a served config as its name and plugins entry only', () => {
    const shown = projectConfigRemotes({ registry: { remotes: [CLOUD, PLANTED] } })

    expect(shown.registry.remotes).toEqual([
      { name: 'cloud', plugin: 'kernel' },
      { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' },
    ])
    for (const text of [...SHOWN_NOWHERE, ...HIDDEN]) {
      expect(JSON.stringify(shown)).not.toContain(text)
    }
  })

  it('shows a plugins entry name that is not a slug as invalid name', () => {
    const shown = projectConfigRemotes({
      registry: { remotes: [{ name: 'cloud', plugin: 'Bearer SETTING_TOKEN' }] },
    })

    expect(shown.registry.remotes).toEqual([{ name: 'cloud', plugin: 'invalid name' }])
  })

  it('hides a copy of its settings found elsewhere in the config', () => {
    const shown = projectConfigRemotes({
      registry: { remotes: [CLOUD] },
      use: { browser: { copied: CLOUD.settings } },
    })

    for (const text of SHOWN_NOWHERE) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows for display as its name and plugins entry', () => {
    expect(projectRemotesForDisplay([CLOUD, PLANTED])).toEqual([
      { name: 'cloud', plugin: 'kernel' },
      { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' },
    ])
  })

  it('is labelled by its name and plugins entry, and a url remote by its protocol and origin', () => {
    expect(remoteLabel(CLOUD)).toBe('cloud (plugin kernel)')
    expect(remoteLabel(PLANTED)).toBe('grid (playwright wss://grid.example.com:443)')
  })

  it("counts the secrets in a plugin remote's settings and a plugins entry's options as connection-only", () => {
    const names = configConnectionSecretNames({
      plugins: [
        {
          name: 'kernel',
          package: '@vostride/agent-qa-plugin-kernel',
          options: {
            apiKey: '{{secret:KERNEL_API_KEY}}',
            account: { id: 'acct-{{secret:KERNEL_ACCOUNT}}' },
          },
        },
      ],
      registry: {
        remotes: [CLOUD, PLANTED],
        targets: {
          shop: { platform: 'web', url: 'https://shop.example.com/{{secret:SHOP_KEY}}' },
        },
      },
    })

    expect(names).toEqual(['BASIC_PASS', 'KERNEL_ACCOUNT', 'KERNEL_API_KEY', 'SETTING_TOKEN'])
  })
})

describe('a plugins entry in a served config', () => {
  const KERNEL = {
    name: 'kernel',
    package: '@vostride/agent-qa-plugin-kernel',
    options: {
      apiKey: '{{secret:KERNEL_API_KEY}}',
      endpoint: 'https://api.kernel.example.com/v1/acct-OPTION_PATH',
      project: 'OPTION_VALUE',
    },
  }
  const LAB = { name: 'lab', path: './tools/lab', options: { region: 'OPTION_REGION' } }
  const SHOWN_NOWHERE = ['KERNEL_API_KEY', 'OPTION_PATH', 'OPTION_VALUE', 'OPTION_REGION', 'apiKey']

  it('shows each entry by its name and package or path, and none of its options', () => {
    const config = {
      plugins: [KERNEL, LAB],
      registry: { remotes: [{ name: 'cloud', plugin: 'kernel', settings: { region: 'eu' } }] },
    }

    const shown = projectConfigRemotes(config)

    expect(shown.plugins).toEqual([
      { name: 'kernel', package: '@vostride/agent-qa-plugin-kernel' },
      { name: 'lab', path: './tools/lab' },
    ])
    expect(shown.registry.remotes).toEqual([{ name: 'cloud', plugin: 'kernel' }])
    expect(config.plugins[0]).toBe(KERNEL)
    for (const text of SHOWN_NOWHERE) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('projects plugins in a config with no remotes and keeps the rest of it', () => {
    const shown = projectConfigRemotes({
      plugins: [LAB],
      registry: { targets: { shop: { platform: 'web', url: 'https://shop.example.com/' } } },
    })

    expect(shown).toEqual({
      plugins: [{ name: 'lab', path: './tools/lab' }],
      registry: { targets: { shop: { platform: 'web', url: 'https://shop.example.com/' } } },
    })
  })

  it('shows a name that is not a slug as invalid name and a package that is no package name as invalid package', () => {
    const shown = projectConfigRemotes({
      plugins: [
        { name: 'Lab OPTION_VALUE', package: 'https://registry.example.com/OPTION_PATH.tgz' },
        { name: 'lab', path: 42 },
        'OPTION_VALUE',
      ],
    })

    expect(shown.plugins).toEqual([
      { name: 'invalid name', package: 'invalid package' },
      { name: 'lab', path: 'invalid path' },
      {},
    ])
    for (const text of SHOWN_NOWHERE) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('drops every key of an entry but its name, package and path', () => {
    const shown = projectConfigRemotes({
      plugins: [{ ...LAB, settings: { token: 'OPTION_VALUE' } }],
    })

    expect(shown.plugins).toEqual([{ name: 'lab', path: './tools/lab' }])
  })

  it('hides a copy of an entry or its options found elsewhere in the config, and shows a url in them by its origin', () => {
    const shown = projectConfigRemotes({
      plugins: [KERNEL, LAB],
      registry: {
        devices: {
          tablet: {
            capabilities: {
              'appium:options': KERNEL.options,
              'appium:entry': LAB,
              'appium:url': KERNEL.options.endpoint,
            },
          },
        },
      },
    })

    expect(shown.registry.devices.tablet.capabilities).toEqual({
      'appium:options': null,
      'appium:entry': { name: 'lab', path: './tools/lab' },
      'appium:url': 'https://api.kernel.example.com:443',
    })
    for (const text of SHOWN_NOWHERE) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('serves a plugins block that is not a list as written, without options in any object inside', () => {
    const shown = projectConfigRemotes({
      plugins: { auth: [KERNEL], providers: { lab: LAB } },
      use: { browser: { copied: LAB.options } },
    })

    expect(shown).toEqual({
      plugins: {
        auth: [{ name: 'kernel', package: '@vostride/agent-qa-plugin-kernel' }],
        providers: { lab: { name: 'lab', path: './tools/lab' } },
      },
      use: { browser: { copied: null } },
    })
    for (const text of SHOWN_NOWHERE) expect(JSON.stringify(shown)).not.toContain(text)
  })
})
