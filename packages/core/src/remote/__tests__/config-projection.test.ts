import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { AgentQaConfigSchema } from '../../schema/config-schema.js'
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

const UNSHOWABLE = '# This config cannot be shown without its remote endpoints.\n'

const WORKSPACE = [
  'workspace:',
  '  testMatch:',
  "    - 'tests/**/*.yaml'",
  '  suiteMatch:',
  "    - 'suites/**/*.suite.yaml'",
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
]

const USE = ['use:', '  browser:', '    name: chromium', '    headless: true', '    remote: grid']

const DEVICES = ['  devices:', '    pixel:', '      platform: android', '      match:']

const GRID_MAP_ENTRY = '    grid: { protocol: playwright, url: "wss://grid.example.com/" }'

const PLANTED_MAP_ENTRY = `{ protocol: playwright, url: "wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}", headers: { X-Team: ${HEADER_VALUE} } }`

function plantedEntry(indent: number): string[] {
  return [
    '- name: grid',
    '  protocol: playwright',
    `  url: wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
    `  headers: { X-Team: ${HEADER_VALUE} }`,
  ].map((line) => ' '.repeat(indent) + line)
}

function loadedUrl(raw: string): unknown {
  const loaded = parseYaml(raw) as { registry?: { remotes?: Array<{ url?: unknown }> } }
  return loaded.registry?.remotes?.[0]?.url
}

function loadedMapUrl(raw: string, key: string): unknown {
  const loaded = parseYaml(raw) as { registry: { remotes: Record<string, { url?: unknown }> } }
  return loaded.registry.remotes[key]?.url
}

function expectNothingPlanted(shown: string): void {
  for (const hidden of [PATH_TOKEN, QUERY_SECRET, HEADER_VALUE, 'X-Team']) {
    expect(shown).not.toContain(hidden)
  }
}

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

  it('returns a config with no remote list, or text with no remotes key that does not parse, unchanged', () => {
    const plain = '# notes\nuse:\n  browser:\n    name:   chromium\n'
    const broken = 'use:\n  browser:\n    name: chromium\n  timeout: [\n'

    expect(projectRemotesInConfigText(plain)).toBe(plain)
    expect(projectRemotesInConfigText(broken)).toBe(broken)
  })

  it('shows a config whose remotes key is an alias as one unshowable line', () => {
    const raw = [
      ...WORKSPACE,
      'registry:',
      '  devices:',
      '    pixel:',
      '      platform: android',
      '      match:',
      '        appPackage: &key remotes',
      '  *key :',
      ...plantedEntry(4),
      ...USE,
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(AgentQaConfigSchema.safeParse(parseYaml(raw)).success).toBe(true)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose registry merges in its remotes through a merge tag as one unshowable line', () => {
    const raw = [
      ...WORKSPACE,
      'registry:',
      '  devices:',
      '    pixel:',
      '      platform: android',
      '      match:',
      '        avd: &r',
      '          remotes:',
      ...plantedEntry(12),
      '  !!merge <<: *r',
      ...USE,
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(AgentQaConfigSchema.safeParse(parseYaml(raw)).success).toBe(true)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a YAML 1.1 config whose registry merges in its remotes as one unshowable line', () => {
    const raw = [
      '%YAML 1.1',
      '---',
      ...WORKSPACE,
      'registry:',
      '  devices:',
      '    pixel:',
      '      platform: android',
      '      match:',
      '        avd: &r',
      '          remotes:',
      ...plantedEntry(12),
      '  <<: *r',
      ...USE,
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(AgentQaConfigSchema.safeParse(parseYaml(raw)).success).toBe(true)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a YAML 1.1 config whose root merges in its registry as one unshowable line', () => {
    const raw = [
      '%YAML 1.1',
      '---',
      ...WORKSPACE,
      ...USE,
      '  extra: &r',
      '    registry:',
      '      remotes:',
      ...plantedEntry(8),
      '<<: *r',
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows text with two remotes keys in one map as one unshowable line', () => {
    const raw = [
      'registry:',
      '  remotes:',
      ...plantedEntry(4),
      '  remotes:',
      '    - name: other',
      '      protocol: playwright',
      '      url: wss://other.example.com/',
      '',
    ].join('\n')

    expect(() => parseYaml(raw)).toThrow()
    const shown = projectRemotesInConfigText(raw)
    expect(shown).toBe(UNSHOWABLE)
    expectNothingPlanted(shown)
  })

  it('shows text that does not parse and holds a remotes key as one unshowable line', () => {
    const raw = [
      'registry:',
      '  remotes:',
      '    - name: grid',
      '      protocol: playwright',
      `      url: wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
      '      headers: [',
      '',
    ].join('\n')

    expect(() => parseYaml(raw)).toThrow()
    const shown = projectRemotesInConfigText(raw)
    expect(shown).toBe(UNSHOWABLE)
    expectNothingPlanted(shown)
  })

  it('shows a config whose remote aliases the document root as one unshowable line', () => {
    const shown = projectRemotesInConfigText(
      [
        '&root',
        'registry:',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        `      url: wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '      headers: *root',
        '',
      ].join('\n'),
    )

    expect(shown).toBe(UNSHOWABLE)
    expectNothingPlanted(shown)
  })

  it('shows a config whose remote reaches an alias of registry through an anchor as one unshowable line', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry: &reg',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      match: &m',
        '        avd: *reg',
        `        serial: ${HEADER_VALUE}`,
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        `      url: wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '      headers: *m',
        '',
      ].join('\n'),
    )

    expect(shown).toBe(UNSHOWABLE)
    expectNothingPlanted(shown)
  })

  it('replaces an anchor that aliases itself with null', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      match:',
        '        serial: &a',
        `          X-Team: ${HEADER_VALUE}`,
        '          self: *a',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        `      url: wss://grid.example.com/${PATH_TOKEN}`,
        '      headers: *a',
        '',
      ].join('\n'),
    )

    expectNothingPlanted(shown)
    expect(parseYaml(shown)).toEqual({
      registry: {
        devices: { pixel: { platform: 'android', match: { serial: null } } },
        remotes: [],
      },
    })
  })

  it('replaces nested anchors that alias each other with null', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      match:',
        '        serial: &a',
        '          inner: &b',
        `            X-Team: ${HEADER_VALUE}`,
        '            back: *a',
        '        avd: *b',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        `      url: wss://grid.example.com/${PATH_TOKEN}`,
        '      headers: *b',
        '',
      ].join('\n'),
    )

    expectNothingPlanted(shown)
    expect(parseYaml(shown)).toEqual({
      registry: {
        devices: { pixel: { platform: 'android', match: { serial: null, avd: null } } },
        remotes: [],
      },
    })
  })

  it('replaces a merge base anchored outside the block with null and still shows the entry', () => {
    const shown = projectRemotesInConfigText(
      [
        '%YAML 1.1',
        '---',
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      match:',
        '        serial: &base',
        '          protocol: playwright',
        `          url: wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        `          headers: { X-Team: ${HEADER_VALUE} }`,
        '  remotes:',
        '    - name: grid',
        '      <<: *base',
        '',
      ].join('\n'),
    )

    expectNothingPlanted(shown)
    expect(parseYaml(shown)).toEqual({
      registry: {
        devices: { pixel: { platform: 'android', match: { serial: null } } },
        remotes: [{ name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }],
      },
    })
  })

  it('shows a config whose later remotes alias key merges in the remotes map and adds an entry as one unshowable line', () => {
    const raw = [
      '%YAML 1.1',
      '---',
      'registry:',
      ...DEVICES,
      '        avd: &k remotes',
      '  remotes: &F',
      GRID_MAP_ENTRY,
      '  *k :',
      '    <<: *F',
      `    other: ${PLANTED_MAP_ENTRY}`,
      '',
    ].join('\n')

    expect(loadedMapUrl(raw, 'other')).toContain(PATH_TOKEN)
    expect(loadedMapUrl(raw, 'grid')).toBe('wss://grid.example.com/')
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose later remotes alias key merges in the remotes map through a merge tag as one unshowable line', () => {
    const raw = [
      'registry:',
      ...DEVICES,
      '        avd: &k remotes',
      '  remotes: &F',
      GRID_MAP_ENTRY,
      '  *k :',
      '    !!merge <<: *F',
      `    other: ${PLANTED_MAP_ENTRY}`,
      '',
    ].join('\n')

    expect(loadedMapUrl(raw, 'other')).toContain(PATH_TOKEN)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose later registry alias key merges in the remotes map as one unshowable line', () => {
    const raw = [
      '%YAML 1.1',
      '---',
      'use:',
      '  browser:',
      '    name: &g registry',
      'registry:',
      '  remotes: &F',
      GRID_MAP_ENTRY,
      '*g :',
      '  remotes:',
      '    <<: *F',
      `    other: ${PLANTED_MAP_ENTRY}`,
      '',
    ].join('\n')

    expect(loadedMapUrl(raw, 'other')).toContain(PATH_TOKEN)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose later remotes alias key merges in the remotes map and redefines its entry as one unshowable line', () => {
    const raw = [
      '%YAML 1.1',
      '---',
      'registry:',
      ...DEVICES,
      '        avd: &k remotes',
      '  remotes: &F',
      GRID_MAP_ENTRY,
      '  *k :',
      '    <<: *F',
      `    grid: ${PLANTED_MAP_ENTRY}`,
      '',
    ].join('\n')

    const loaded = parseYaml(raw) as { registry: { remotes: Record<string, unknown> } }
    expect(Object.keys(loaded.registry.remotes)).toEqual(['grid'])
    expect(loadedMapUrl(raw, 'grid')).toContain(PATH_TOKEN)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a remotes map that a merge copies elsewhere as one unshowable line, even when the merge adds nothing', () => {
    const raw = [
      '%YAML 1.1',
      '---',
      'registry:',
      '  remotes: &F',
      GRID_MAP_ENTRY,
      ...DEVICES,
      '        avd:',
      '          <<: *F',
      '',
    ].join('\n')

    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose registry key is an alias as one unshowable line', () => {
    const raw = [
      'use:',
      '  browser:',
      '    remote: grid',
      '    name: &g registry',
      '*g :',
      '  remotes:',
      ...plantedEntry(4),
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose registry alias key overrides a plain registry as one unshowable line', () => {
    const raw = [
      'use:',
      '  browser:',
      '    name: &g registry',
      'registry:',
      '  remotes: []',
      '*g :',
      '  remotes:',
      ...plantedEntry(4),
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose remotes alias key overrides a plain remotes key as one unshowable line', () => {
    const raw = [
      ...WORKSPACE,
      'registry:',
      ...DEVICES,
      '        avd: &k remotes',
      '  remotes: []',
      '  *k :',
      ...plantedEntry(4),
      ...USE,
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(AgentQaConfigSchema.safeParse(parseYaml(raw)).success).toBe(true)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose root merges in its registry through a merge tag as one unshowable line', () => {
    const raw = [
      'use:',
      '  browser:',
      '    remote: grid',
      '  extra: &r',
      '    registry:',
      '      remotes:',
      ...plantedEntry(8),
      '!!merge <<: *r',
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose merge tag is spelled through a tag directive as one unshowable line', () => {
    const raw = [
      '%TAG !e! tag:yaml.org,2002:',
      '---',
      ...WORKSPACE,
      'registry:',
      ...DEVICES,
      '        avd: &r',
      '          remotes:',
      ...plantedEntry(12),
      '  !e!merge <<: *r',
      ...USE,
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(AgentQaConfigSchema.safeParse(parseYaml(raw)).success).toBe(true)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a config whose merge tag is written verbatim as one unshowable line', () => {
    const raw = [
      ...WORKSPACE,
      'registry:',
      ...DEVICES,
      '        avd: &r',
      '          remotes:',
      ...plantedEntry(12),
      '  !<tag:yaml.org,2002:merge> <<: *r',
      ...USE,
      '',
    ].join('\n')

    expect(loadedUrl(raw)).toContain(PATH_TOKEN)
    expect(AgentQaConfigSchema.safeParse(parseYaml(raw)).success).toBe(true)
    expect(projectRemotesInConfigText(raw)).toBe(UNSHOWABLE)
  })

  it('shows a remote whose name is an alias of its url as invalid name', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  remotes:',
        `    - url: &u wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '      protocol: playwright',
        '      name: *u',
        '',
      ].join('\n'),
    )

    expectNothingPlanted(shown)
    expect(parseYaml(shown)).toEqual({
      registry: {
        remotes: [
          { name: 'invalid name', protocol: 'playwright', url: 'wss://grid.example.com:443' },
        ],
      },
    })
  })

  it('shows a remote whose protocol is an alias of its url as invalid protocol', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  remotes:',
        `    - url: &u wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '      name: grid',
        '      protocol: *u',
        '',
      ].join('\n'),
    )

    expectNothingPlanted(shown)
    expect(parseYaml(shown)).toEqual({
      registry: {
        remotes: [
          { name: 'grid', protocol: 'invalid protocol', url: 'wss://grid.example.com:443' },
        ],
      },
    })
  })

  it('shows a remote whose name aliases a url anchored outside the block as invalid name, and that anchor as null', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        ...DEVICES,
        `        avd: &u wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '  remotes:',
        '    - name: *u',
        '      protocol: playwright',
        '      url: wss://grid.example.com/',
        '',
      ].join('\n'),
    )

    expectNothingPlanted(shown)
    expect(parseYaml(shown)).toEqual({
      registry: {
        devices: { pixel: { platform: 'android', match: { avd: null } } },
        remotes: [
          { name: 'invalid name', protocol: 'playwright', url: 'wss://grid.example.com:443' },
        ],
      },
    })
  })

  it('shows a name anchored inside the block as invalid name, and its alias outside as null', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  remotes:',
        `    - name: &n wss://grid.example.com/${PATH_TOKEN}?k=${QUERY_SECRET}`,
        '      protocol: playwright',
        '      url: wss://grid.example.com/',
        ...DEVICES,
        '        avd: *n',
        '',
      ].join('\n'),
    )

    expectNothingPlanted(shown)
    expect(parseYaml(shown)).toEqual({
      registry: {
        remotes: [
          { name: 'invalid name', protocol: 'playwright', url: 'wss://grid.example.com:443' },
        ],
        devices: { pixel: { platform: 'android', match: { avd: null } } },
      },
    })
  })
})
