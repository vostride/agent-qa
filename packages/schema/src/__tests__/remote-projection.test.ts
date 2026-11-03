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
})
