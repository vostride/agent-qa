import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { projectRemotesInConfigText } from '../config-projection.js'

const PATH_TOKEN = 'pathtoken-7f3a'
const QUERY_SECRET = 'querysecret-91bc'
const HEADER_VALUE = 'headervalue-c0de'

const CONFIG = [
  '# owner notes: the grid is the team one',
  'registry:',
  '  remotes:',
  '    - name: grid',
  '      protocol: playwright',
  `      url: wss://grid.example.com/${PATH_TOKEN}/playwright?key=${QUERY_SECRET}`,
  '      headers:',
  `        Authorization: Bearer ${HEADER_VALUE}`,
  '  llms:',
  '    - name: judge',
  '      provider: openai',
  'use: # the browser runs on the grid',
  '  browser:',
  '    name: chromium',
  '    remote: grid',
  '',
].join('\n')

describe('projectRemotesInConfigText', () => {
  it('keeps every comment and key outside registry.remotes and shows a remote by name, protocol and origin only', () => {
    const shown = projectRemotesInConfigText(CONFIG)

    expect(shown).toContain('# owner notes: the grid is the team one')
    expect(shown).toContain('# the browser runs on the grid')
    for (const hidden of [PATH_TOKEN, QUERY_SECRET, HEADER_VALUE, 'Authorization', 'headers']) {
      expect(shown).not.toContain(hidden)
    }
    const original = parseYaml(CONFIG) as Record<string, Record<string, unknown>>
    expect(parseYaml(shown)).toEqual({
      ...original,
      registry: {
        ...original.registry,
        remotes: [{ name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }],
      },
    })
  })

  it('shows a remote whose url does not parse as invalid url', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  remotes:',
        '    - name: grid',
        '      protocol: cdp',
        '      url: not a url',
        '',
      ].join('\n'),
    )

    expect(parseYaml(shown)).toEqual({
      registry: { remotes: [{ name: 'grid', protocol: 'cdp', url: 'invalid url' }] },
    })
  })

  it('shows remotes aliased from an anchor elsewhere, and replaces that anchor too', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  devices:',
        '    pixel:',
        '      match:',
        '        avd: &r',
        '          - name: grid',
        '            protocol: playwright',
        `            url: wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '  remotes: *r',
        '',
      ].join('\n'),
    )

    const grid = { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }
    expect(shown).not.toContain(PATH_TOKEN)
    expect(shown).not.toContain(QUERY_SECRET)
    expect(parseYaml(shown)).toEqual({
      registry: { devices: { pixel: { match: { avd: [grid] } } }, remotes: [grid] },
    })
  })

  it('replaces every alias of an anchor inside the remotes block and keeps the file readable', () => {
    const shown = projectRemotesInConfigText(
      [
        '# kept',
        'workspace:',
        "  testMatch: ['tests/**/*.yaml']",
        'registry:',
        '  remotes: &r',
        '    - name: grid',
        '      protocol: playwright',
        `      url: &u wss://grid.example.com/${PATH_TOKEN}`,
        '      headers: &h',
        `        X-Team: ${HEADER_VALUE}`,
        '  devices:',
        '    pixel:',
        '      match:',
        '        avd: *r',
        '        serial: *u',
        '        model: *h',
        '',
      ].join('\n'),
    )

    const grid = { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }
    for (const hidden of [PATH_TOKEN, HEADER_VALUE, 'X-Team']) expect(shown).not.toContain(hidden)
    expect(shown).toContain('# kept')
    expect(shown).toContain("testMatch: ['tests/**/*.yaml']")
    expect(parseYaml(shown)).toEqual({
      workspace: { testMatch: ['tests/**/*.yaml'] },
      registry: {
        remotes: [grid],
        devices: { pixel: { match: { avd: [grid], serial: null, model: null } } },
      },
    })
  })

  it('replaces a url anchored outside the block with its origin, wherever that anchor is aliased', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      match:',
        `        avd: &grid wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '        serial: *grid',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        '      url: *grid',
        '',
      ].join('\n'),
    )

    const origin = 'wss://grid.example.com:443'
    expect(shown).not.toContain(PATH_TOKEN)
    expect(shown).not.toContain(QUERY_SECRET)
    expect(parseYaml(shown)).toEqual({
      registry: {
        devices: { pixel: { platform: 'android', match: { avd: origin, serial: origin } } },
        remotes: [{ name: 'grid', protocol: 'playwright', url: origin }],
      },
    })
  })

  it('replaces headers anchored outside the block with null', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      match:',
        '        serial: &hdrs',
        `          X-Team: ${HEADER_VALUE}`,
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        '      url: wss://grid.example.com/grid',
        '      headers: *hdrs',
        '',
      ].join('\n'),
    )

    expect(shown).not.toContain(HEADER_VALUE)
    expect(shown).not.toContain('X-Team')
    expect(parseYaml(shown)).toEqual({
      registry: {
        devices: { pixel: { platform: 'android', match: { serial: null } } },
        remotes: [{ name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }],
      },
    })
  })

  it('replaces a whole entry anchored outside the block with null', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      match:',
        '        appPackage: &entry',
        '          name: grid',
        '          protocol: playwright',
        `          url: wss://grid.example.com/${PATH_TOKEN}`,
        `          headers: { X-Team: ${HEADER_VALUE} }`,
        '  remotes:',
        '    - *entry',
        '',
      ].join('\n'),
    )

    for (const hidden of [PATH_TOKEN, HEADER_VALUE, 'X-Team']) expect(shown).not.toContain(hidden)
    expect(parseYaml(shown)).toEqual({
      registry: {
        devices: { pixel: { platform: 'android', match: { appPackage: null } } },
        remotes: [{ name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }],
      },
    })
  })

  it('follows an anchor chain to every anchor it reaches', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      match:',
        `        avd: &lbl ${HEADER_VALUE}`,
        '        serial: &hdrs',
        '          X-Team: *lbl',
        `        platformVersion: &ep wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '        appPackage: &entry',
        '          name: grid',
        '          protocol: playwright',
        '          url: *ep',
        '          headers: *hdrs',
        '    tablet:',
        '      platform: android',
        '      match:',
        '        avd: *lbl',
        '  remotes:',
        '    - *entry',
        '',
      ].join('\n'),
    )

    for (const hidden of [PATH_TOKEN, QUERY_SECRET, HEADER_VALUE, 'X-Team']) {
      expect(shown).not.toContain(hidden)
    }
    const origin = 'wss://grid.example.com:443'
    expect(parseYaml(shown)).toEqual({
      registry: {
        devices: {
          pixel: {
            platform: 'android',
            match: { avd: null, serial: null, platformVersion: origin, appPackage: null },
          },
          tablet: { platform: 'android', match: { avd: null } },
        },
        remotes: [{ name: 'grid', protocol: 'playwright', url: origin }],
      },
    })
  })

  it('shows a config whose remote aliases a node that holds the block as one unshowable line', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry: &reg',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        `      url: wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '      headers: *reg',
        '',
      ].join('\n'),
    )

    expect(shown).toBe('# This config cannot be shown without its remote endpoints.\n')
  })

  it('shows a remotes block that is not a list as an empty list', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  remotes:',
        '    grid:',
        `      url: wss://grid.example.com/${PATH_TOKEN}`,
        '',
      ].join('\n'),
    )

    expect(shown).not.toContain(PATH_TOKEN)
    expect(parseYaml(shown)).toEqual({ registry: { remotes: [] } })
  })

  it('returns a config with no remote list, or text that does not parse, unchanged', () => {
    const plain = '# notes\nuse:\n  browser:\n    name:   chromium\n'
    const broken = 'registry:\n  remotes: [\n'

    expect(projectRemotesInConfigText(plain)).toBe(plain)
    expect(projectRemotesInConfigText(broken)).toBe(broken)
  })
})
