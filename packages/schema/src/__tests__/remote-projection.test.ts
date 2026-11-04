import { describe, expect, it } from 'vitest'

import { projectConfigRemotes, projectRemotesForDisplay } from '../config/remote'

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
          pixel: { match: { avd: [PLANTED], serial: PLANTED, model: PLANTED.basicAuth } },
          tablet: { match: { url: PLANTED.url } },
        },
      },
    })

    const grid = { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }
    expect(shown.registry.devices).toEqual({
      pixel: { match: { avd: [grid], serial: grid, model: null } },
      tablet: { match: { url: 'wss://grid.example.com:443' } },
    })
    for (const text of HIDDEN) expect(JSON.stringify(shown)).not.toContain(text)
  })

  it('shows a url copied from a remotes block that is not a list as its origin', () => {
    const shown = projectConfigRemotes({
      registry: {
        remotes: { grid: PLANTED },
        devices: { tablet: { match: { url: PLANTED.url, serial: PLANTED.headers } } },
      },
    })

    expect(shown.registry).toEqual({
      remotes: [],
      devices: { tablet: { match: { url: 'wss://grid.example.com:443', serial: null } } },
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
        devices: { tablet: { match: { avd: PLANTED.url, serial: PLANTED.headers } } },
      },
    })

    expect(shown.registry.remotes).toEqual([
      { name: 'invalid name', protocol: 'playwright', url: 'wss://lab.example.com:443' },
      { name: 'grid', protocol: 'invalid protocol', url: 'wss://grid.example.com:443' },
      { name: 'grid.2', protocol: 'cdp', url: 'ws://127.0.0.1:9222' },
      { url: 'wss://grid.example.com:443' },
    ])
    expect(shown.registry.devices).toEqual({
      tablet: { match: { avd: 'invalid name', serial: null } },
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
          devices: { tablet: { match: { url: PLANTED.url, serial: PLANTED.headers } } },
        },
      })

      expect(shown.registry.remotes).toEqual(shownRemotes)
      expect(shown.registry.devices).toEqual({
        tablet: { match: { url: 'wss://grid.example.com:443', serial: null } },
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
        devices: { tablet: { match: { url: PLANTED.url } } },
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
      devices: { tablet: { match: { url: 'wss://grid.example.com:443' } } },
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
})
