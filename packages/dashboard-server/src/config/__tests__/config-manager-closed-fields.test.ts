import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { ConfigChange } from '@vostride/agent-qa-schema'

import { ConfigManager } from '../index.js'

const SUBSCRIPTION_AUTH = { name: 'subscription', package: '@vostride/agent-qa-subscription-auth' }

const WORKSPACE = [
  '# owner notes: the grid is the team one',
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
]

const USE = [
  'use:',
  '  timeout:',
  '    step: 30s',
  '    test: 10m',
  '    navigation: 10s',
  '  browser:',
  '    name: chromium',
  '    headless: false',
  '  mobile:',
  '    appState: preserve',
]

const WITH_PLUGINS = [
  ...WORKSPACE,
  'registry:',
  '  remotes:',
  '    - name: grid',
  '      protocol: playwright',
  '      url: wss://grid.example.com/playwright',
  '      headers:',
  '        Authorization: Bearer {{secret:GRID_TOKEN}}',
  ...USE.slice(0, -2),
  '    remote: grid',
  ...USE.slice(-2),
  'plugins:',
  '  - name: local',
  '    path: ./auth-plugin.mjs',
  '',
].join('\n')

const WITHOUT_PLUGINS = [...WORKSPACE, 'registry: {}', ...USE, ''].join('\n')

const EVIL_GRID = {
  name: 'grid',
  protocol: 'playwright',
  url: 'wss://evil.example.com/playwright',
  headers: { Authorization: 'Bearer {{secret:GRID_TOKEN}}' },
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function configFile(text: string): Promise<{ manager: ConfigManager; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-closed-fields-'))
  tempDirs.push(dir)
  const path = join(dir, 'agent-qa.config.yaml')
  await writeFile(path, text, 'utf-8')
  return { manager: new ConfigManager(path, (value) => value), path }
}

async function expectRefused(text: string, refused: readonly ConfigChange[][]): Promise<void> {
  const { manager, path } = await configFile(text)
  for (const changes of refused) {
    expect([changes, await manager.applyChanges(changes)]).toEqual([
      changes,
      { kind: 'refused', error: 'path_not_writable' },
    ])
    expect(await readFile(path, 'utf-8')).toBe(text)
  }
}

describe("the config's closed fields", () => {
  it('a field, an ancestor, the root, a move, an unset or a plugin change to the closed fields is refused', async () => {
    const whole = parseYaml(WITH_PLUGINS) as Record<string, unknown>
    await expectRefused(WITH_PLUGINS, [
      [{ op: 'set', path: ['registry', 'remotes', 0, 'url'], value: EVIL_GRID.url }],
      [{ op: 'set', path: ['registry'], value: { remotes: [EVIL_GRID] } }],
      [{ op: 'set', path: [], value: { ...whole, registry: { remotes: [EVIL_GRID] } } }],
      [{
        op: 'move',
        from: ['use', 'timeout', 'step'],
        path: ['registry', 'remotes', 0, 'connectTimeout'],
      }],
      [{ op: 'move', from: ['registry', 'remotes'], path: ['use', 'timeout', 'step'] }],
      [{ op: 'unset', path: ['registry', 'remotes'] }],
      [{ op: 'append', path: ['registry', 'remotes'], value: { ...EVIL_GRID, name: 'second' } }],
      [{ op: 'set', path: ['plugins'], value: [{ name: 'provider', package: '@acme/provider' }] }],
      [{ op: 'append', path: ['plugins'], value: { name: 'acme', package: '@acme/other-auth' } }],
      [{ op: 'set', path: ['plugins', 0, 'path'], value: './other-plugin.mjs' }],
      [{ op: 'unset', path: ['plugins'] }],
    ])
  })

  it('the subscription-auth append, the remote pick and unrelated fields are written', async () => {
    const { manager, path } = await configFile(WITH_PLUGINS)
    const accepted: ConfigChange[][] = [
      [{ op: 'append', path: ['plugins'], value: SUBSCRIPTION_AUTH }],
      [{ op: 'set', path: ['use', 'browser', 'remote'], value: 'local' }],
      [{ op: 'set', path: ['use', 'browser', 'remote'], value: 'grid' }],
      [{ op: 'set', path: ['use', 'workers'], value: 4 }],
    ]
    for (const changes of accepted) {
      expect([changes, (await manager.applyChanges(changes)).kind]).toEqual([changes, 'ok'])
    }
    const written = parseYaml(await readFile(path, 'utf-8')) as {
      registry: unknown
      plugins: unknown
      use: { browser: { remote?: unknown }; workers: unknown }
    }
    expect(written.registry).toEqual((parseYaml(WITH_PLUGINS) as { registry: unknown }).registry)
    expect(written.plugins).toEqual([
      { name: 'local', path: './auth-plugin.mjs' },
      SUBSCRIPTION_AUTH,
    ])
    expect(written.use.browser.remote).toBe('grid')
    expect(written.use.workers).toBe(4)
  })

  it('a whole registry that keeps the remotes as they are is written', async () => {
    const { manager, path } = await configFile(WITH_PLUGINS)
    const registry = (parseYaml(WITH_PLUGINS) as { registry: Record<string, unknown> }).registry
    const llm = { name: 'judge', provider: 'openai-subscription', model: 'gpt-5.6-terra' }
    const outcome = await manager.applyChanges([
      { op: 'set', path: ['registry'], value: { ...registry, llms: [llm] } },
    ])
    expect(outcome).toMatchObject({ kind: 'ok' })
    expect((parseYaml(await readFile(path, 'utf-8')) as { registry: unknown }).registry)
      .toEqual({ ...registry, llms: [llm] })
  })

  it('on a config with no plugins block the subscription-auth append creates plugins with that one entry', async () => {
    const { manager, path } = await configFile(WITHOUT_PLUGINS)
    const outcome = await manager.applyChanges([
      { op: 'append', path: ['plugins'], value: SUBSCRIPTION_AUTH },
    ])
    expect(outcome).toMatchObject({ kind: 'ok' })
    expect((parseYaml(await readFile(path, 'utf-8')) as { plugins: unknown }).plugins)
      .toEqual([SUBSCRIPTION_AUTH])
  })

  it('the served config and its file lines show a remote by name, protocol and origin only', async () => {
    const { manager } = await configFile(WITH_PLUGINS)
    const read = await manager.readMasked()
    if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

    const shown = { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }
    expect((read.config.registry as { remotes: unknown }).remotes).toEqual([shown])
    const text = read.lines.map((line) => line.text).join('\n')
    expect(text).toContain('# owner notes: the grid is the team one')
    expect(text).toContain('./auth-plugin.mjs')
    for (const hidden of ['/playwright', 'Authorization', 'GRID_TOKEN', 'headers']) {
      expect(JSON.stringify(read.config)).not.toContain(hidden)
      expect(text).not.toContain(hidden)
    }
    expect((parseYaml(text) as { registry: { remotes: unknown } }).registry.remotes).toEqual([shown])
  })

  it('the served config and its file lines hide a remote whose entry, url and headers alias anchors outside its block', async () => {
    const pathToken = 'pathtoken-5e2b'
    const queryValue = 'queryvalue-a41d'
    const headerValue = 'headervalue-08f7'
    const { manager } = await configFile(
      [
        ...WORKSPACE,
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      capabilities:',
        `        appium:platformVersion: &ep wss://grid.example.com/${pathToken}?k=${queryValue}`,
        '        appium:serial: &hdrs',
        `          X-Team: ${headerValue}`,
        '        appium:appPackage: &entry',
        '          name: grid',
        '          protocol: playwright',
        '          url: *ep',
        '          headers: *hdrs',
        '  remotes:',
        '    - *entry',
        ...USE,
        '',
      ].join('\n'),
    )
    const read = await manager.readMasked()
    if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

    const origin = 'wss://grid.example.com:443'
    const shown = [{ name: 'grid', protocol: 'playwright', url: origin }]
    const text = read.lines.map((line) => line.text).join('\n')
    const lines = parseYaml(text) as {
      registry: { remotes: unknown; devices: { pixel: { capabilities: unknown } } }
    }
    expect((read.config.registry as { remotes: unknown }).remotes).toEqual(shown)
    expect(lines.registry.remotes).toEqual(shown)
    expect(lines.registry.devices.pixel.capabilities).toEqual({
      'appium:platformVersion': origin,
      'appium:serial': null,
      'appium:appPackage': null,
    })
    for (const hidden of [pathToken, queryValue, headerValue, 'X-Team']) {
      expect(JSON.stringify(read.config)).not.toContain(hidden)
      expect(text).not.toContain(hidden)
    }
  })

  it('the served config and its file lines hide a remotes map whose url and headers are aliased outside it', async () => {
    const pathToken = 'pathtoken-3c9e'
    const queryValue = 'queryvalue-d27a'
    const headerValue = 'headervalue-6b14'
    const { manager } = await configFile(
      [
        ...WORKSPACE,
        'registry:',
        '  remotes:',
        '    grid:',
        '      protocol: playwright',
        `      url: &u wss://grid.example.com/${pathToken}?k=${queryValue}`,
        '      headers: &h',
        `        X-Team: ${headerValue}`,
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      capabilities:',
        '        appium:avd: *u',
        '        appium:serial: *h',
        ...USE,
        '',
      ].join('\n'),
    )
    const read = await manager.readMasked()
    if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

    expect(read.fileIssues).not.toEqual([])
    const config = read.config.registry as {
      remotes: unknown
      devices: { pixel: { capabilities: unknown } }
    }
    expect(config.remotes).toEqual([])
    expect(config.devices.pixel.capabilities).toEqual({
      'appium:avd': 'wss://grid.example.com:443',
      'appium:serial': null,
    })
    const text = read.lines.map((line) => line.text).join('\n')
    const lines = parseYaml(text) as {
      registry: { remotes: unknown; devices: { pixel: { capabilities: unknown } } }
    }
    expect(lines.registry.remotes).toEqual([])
    expect(lines.registry.devices.pixel.capabilities).toEqual({
      'appium:avd': null,
      'appium:serial': null,
    })
    for (const hidden of [pathToken, queryValue, headerValue, 'X-Team']) {
      expect(JSON.stringify(read.config)).not.toContain(hidden)
      expect(text).not.toContain(hidden)
    }
  })

  it('the served file lines are one line for a remotes map that a later alias key merges in and extends', async () => {
    const pathPart = 'routepart-9d1e'
    const queryValue = 'queryvalue-4f60'
    const headerValue = 'headervalue-b7a3'
    const url = `wss://grid.example.com/${pathPart}?team=${queryValue}`
    const { manager } = await configFile(
      [
        '%YAML 1.1',
        '---',
        ...WORKSPACE,
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      capabilities:',
        '        appium:avd: &k remotes',
        '  remotes: &F',
        '    grid: { protocol: playwright, url: "wss://grid.example.com/" }',
        '  *k :',
        '    <<: *F',
        `    other: { protocol: playwright, url: "${url}", headers: { X-Team: ${headerValue} } }`,
        ...USE,
        '',
      ].join('\n'),
    )
    const read = await manager.readMasked()
    if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

    expect(read.fileIssues).not.toEqual([])
    expect(read.lines).toEqual([
      { n: 1, text: '# This config cannot be shown without its remote endpoints.' },
    ])
    expect(read.config.registry).toEqual({
      devices: { pixel: { platform: 'android', capabilities: { 'appium:avd': 'remotes' } } },
      remotes: [],
    })
    const text = read.lines.map((line) => line.text).join('\n')
    for (const hidden of [pathPart, queryValue, headerValue, 'X-Team']) {
      expect(JSON.stringify(read.config)).not.toContain(hidden)
      expect(text).not.toContain(hidden)
    }
  })

  it('the served config and its file lines show a name that aliases a url as invalid name', async () => {
    const pathPart = 'routepart-9d1e'
    const queryValue = 'queryvalue-4f60'
    const headerValue = 'headervalue-b7a3'
    const { manager } = await configFile(
      [
        ...WORKSPACE,
        'registry:',
        '  devices:',
        '    pixel:',
        '      platform: android',
        '      capabilities:',
        `        appium:avd: &u wss://grid.example.com/${pathPart}?team=${queryValue}`,
        '  remotes:',
        '    - name: *u',
        '      protocol: playwright',
        '      url: wss://grid.example.com/',
        ...USE,
        '',
      ].join('\n'),
    )
    const read = await manager.readMasked()
    if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

    expect(read.fileIssues).not.toEqual([])
    const remotes = [
      { name: 'invalid name', protocol: 'playwright', url: 'wss://grid.example.com:443' },
    ]
    const config = read.config.registry as {
      remotes: unknown
      devices: { pixel: { capabilities: unknown } }
    }
    expect(config.remotes).toEqual(remotes)
    expect(config.devices.pixel.capabilities).toEqual({ 'appium:avd': 'invalid name' })
    const text = read.lines.map((line) => line.text).join('\n')
    const lines = parseYaml(text) as {
      registry: { remotes: unknown; devices: { pixel: { capabilities: unknown } } }
    }
    expect(lines.registry.remotes).toEqual(remotes)
    expect(lines.registry.devices.pixel.capabilities).toEqual({ 'appium:avd': null })
    for (const hidden of [pathPart, queryValue, headerValue, 'X-Team']) {
      expect(JSON.stringify(read.config)).not.toContain(hidden)
      expect(text).not.toContain(hidden)
    }
  })

  it('the served config and its file lines hide a url aliased out of an ordered map or set remotes block, or out of an ordered map entry', async () => {
    const pathPart = 'routepart-9d1e'
    const queryValue = 'queryvalue-4f60'
    const headerValue = 'headervalue-b7a3'
    const url = `wss://grid.example.com/${pathPart}?team=${queryValue}`
    const devices = ['  devices:', '    pixel:', '      platform: android', '      capabilities:']
    const blockFile = (block: string[]): string =>
      [...WORKSPACE, 'registry:', ...block, ...devices, '        appium:avd: *u', ...USE, ''].join(
        '\n',
      )
    const unshowable = [
      { n: 1, text: '# This config cannot be shown without its remote endpoints.' },
    ]
    const blockRegistry = {
      remotes: [],
      devices: {
        pixel: {
          platform: 'android',
          capabilities: { 'appium:avd': 'wss://grid.example.com:443' },
        },
      },
    }
    const entryFile = [
      ...WORKSPACE,
      'registry:',
      '  remotes:',
      '    - !!omap',
      '      - name: grid',
      `      - url: &u ${url}`,
      `      - headers: &h { X-Team: ${headerValue} }`,
      ...devices,
      '        appium:avd: *u',
      '        appium:serial: *h',
      ...USE,
      '',
    ].join('\n')

    for (const file of [
      blockFile(['  remotes: !!omap', `    - grid: &u ${url}`]),
      blockFile(['  remotes: !!set', `    ? &u ${url}`]),
      entryFile,
    ]) {
      const { manager } = await configFile(file)
      const read = await manager.readMasked()
      if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

      expect(read.fileIssues).not.toEqual([])
      const text = read.lines.map((line) => line.text).join('\n')
      if (file === entryFile) {
        const config = read.config.registry as {
          remotes: unknown
          devices: { pixel: { capabilities: unknown } }
        }
        expect(config.remotes).toEqual([{ url: 'invalid url' }])
        expect(config.devices.pixel.capabilities).toEqual({
          'appium:avd': 'wss://grid.example.com:443',
          'appium:serial': null,
        })
        const lines = parseYaml(text) as {
          registry: { remotes: unknown; devices: { pixel: { capabilities: unknown } } }
        }
        expect(lines.registry.remotes).toEqual([{ url: 'invalid url' }])
        expect(lines.registry.devices.pixel.capabilities).toEqual({
          'appium:avd': null,
          'appium:serial': null,
        })
      } else {
        expect(read.lines).toEqual(unshowable)
        expect(read.config.registry).toEqual(blockRegistry)
      }
      for (const hidden of [pathPart, queryValue, headerValue, 'X-Team']) {
        expect(JSON.stringify(read.config)).not.toContain(hidden)
        expect(text).not.toContain(hidden)
      }
    }
  })

  it('the served config shows a remote url used as a key elsewhere by its origin, in a config the strict parse accepts', async () => {
    const pathPart = 'routepart-9d1e'
    const queryValue = 'queryvalue-4f60'
    const { manager } = await configFile(
      [
        ...WORKSPACE,
        'registry:',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        `      url: &u wss://grid.example.com/${pathPart}?team=${queryValue}`,
        '  llms:',
        '    - name: judge',
        '      provider: anthropic-compatible',
        '      model: m',
        '      baseURL: https://llm.example.com/v1',
        '      providerHeaders:',
        '        *u : x',
        ...USE.slice(0, -2),
        '    remote: grid',
        ...USE.slice(-2),
        '',
      ].join('\n'),
    )
    const read = await manager.readMasked()
    if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

    expect(read.fileIssues).toEqual([])
    const config = read.config.registry as { llms: { providerHeaders: unknown }[] }
    expect(config.llms[0]?.providerHeaders).toEqual({ 'wss://grid.example.com:443': 'x' })
    const text = read.lines.map((line) => line.text).join('\n')
    const lines = parseYaml(text) as { registry: { llms: { providerHeaders: unknown }[] } }
    expect(lines.registry.llms[0]?.providerHeaders).toEqual({ '': 'x' })
    for (const hidden of [pathPart, queryValue, 'X-Team']) {
      expect(JSON.stringify(read.config)).not.toContain(hidden)
      expect(text).not.toContain(hidden)
    }
  })

  it('the served config shows a remote url anchored in a key yaml writes from a collection by its origin, in configs the strict parse accepts', async () => {
    const pathPart = 'routepart-3c58'
    const queryValue = 'queryvalue-e6b2'
    const url = `wss://grid.example.com/${pathPart}?team=${queryValue}`
    const llm = [
      '  llms:',
      '    - name: judge',
      '      provider: anthropic-compatible',
      '      model: m',
      '      baseURL: https://llm.example.com/v1',
      '      providerHeaders:',
    ]
    type Registry = { llms?: { providerHeaders: unknown }[]; devices?: unknown }
    const headersOf = (registry: Registry): unknown => registry.llms?.[0]?.providerHeaders
    const devicesOf = (registry: Registry): unknown => registry.devices
    const cases = [
      {
        lines: [...llm, `        ? [ &u ${url} ]`, '        : x'],
        pick: headersOf,
        config: { '[ &u wss://grid.example.com:443 ]': 'x' },
        text: { '[ wss://grid.example.com:443 ]': 'x' },
      },
      {
        lines: [...llm, `        ? { h: &u ${url} }`, '        : x'],
        pick: headersOf,
        config: { '{ h: &u wss://grid.example.com:443 }': 'x' },
        text: { '{ h: wss://grid.example.com:443 }': 'x' },
      },
      {
        lines: ['  devices:', `    ? [ &u ${url} ]`, '    : { platform: android }'],
        pick: devicesOf,
        config: { '[ &u wss://grid.example.com:443 ]': { platform: 'android' } },
        text: { '[ wss://grid.example.com:443 ]': { platform: 'android' } },
      },
    ]
    for (const { lines, pick, config, text } of cases) {
      const { manager } = await configFile(
        [
          ...WORKSPACE,
          'registry:',
          ...lines,
          '  remotes:',
          '    - name: grid',
          '      protocol: playwright',
          '      url: *u',
          ...USE.slice(0, -2),
          '    remote: grid',
          ...USE.slice(-2),
          '',
        ].join('\n'),
      )
      const read = await manager.readMasked()
      if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

      expect(read.fileIssues).toEqual([])
      expect(pick(read.config.registry as Registry)).toEqual(config)
      const shownText = read.lines.map((line) => line.text).join('\n')
      const parsedLines = parseYaml(shownText, { logLevel: 'error' }) as { registry: Registry }
      expect(pick(parsedLines.registry)).toEqual(text)
      for (const hidden of [pathPart, queryValue, 'X-Team']) {
        expect(JSON.stringify(read.config)).not.toContain(hidden)
        expect(shownText).not.toContain(hidden)
      }
    }
  })

  it('the served config shows a key yaml folds or escapes from a remote url whole as its origin when a shorter url of the block starts that url', async () => {
    const pathPart = 'routepart-3c58'
    const queryValue = 'queryvalue-e6b2'
    const prefix = `wss://grid.example.com/${pathPart}`
    const longUrl = `${prefix}/${pathPart}/${pathPart}/${pathPart}?team=${queryValue}&lane=${queryValue}`
    const lab = (url: string) => [
      '    - name: lab',
      '      protocol: playwright',
      `      url: ${url}`,
    ]
    const cases = [
      { key: longUrl, extra: lab(prefix) },
      { key: `${prefix}\\t${pathPart}?team=${queryValue}`, extra: lab(prefix) },
      { key: longUrl, extra: ['      headers:', `        X-Lane: ${prefix}`] },
      { key: longUrl, extra: lab(`${prefix}/${pathPart}`) },
    ]
    for (const { key, extra } of cases) {
      const { manager } = await configFile(
        [
          ...WORKSPACE,
          'registry:',
          '  devices:',
          '    pixel:',
          '      platform: android',
          '      capabilities:',
          '        appium:avd:',
          `          ? [ &u "${key}" ]`,
          '          : x',
          '  remotes:',
          '    - name: grid',
          '      protocol: playwright',
          '      url: *u',
          ...extra,
          ...USE.slice(0, -2),
          '    remote: grid',
          ...USE.slice(-2),
          '',
        ].join('\n'),
      )
      const read = await manager.readMasked()
      if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)
      const registry = read.config.registry as { devices: { pixel: { capabilities: unknown } } }

      expect(read.fileIssues).toEqual([])
      expect(registry.devices.pixel.capabilities).toEqual({
        'appium:avd': { 'wss://grid.example.com:443': 'x' },
      })
      const shownText = read.lines.map((line) => line.text).join('\n')
      for (const hidden of [pathPart, queryValue]) {
        expect(JSON.stringify(read.config)).not.toContain(hidden)
        expect(shownText).not.toContain(hidden)
      }
    }
  })

  describe('a key that holds a remote url both as written and as yaml folds it, when a shorter url of the block starts that url', () => {
    const pathPart = 'routepart-3c58'
    const queryValue = 'queryvalue-e6b2'
    const prefix = `wss://grid.example.com/${pathPart}`
    const midUrl = `${prefix}/${pathPart}?team=${queryValue}`
    const longUrl = `${prefix}/${pathPart}/${pathPart}/${pathPart}?team=${queryValue}&lane=${queryValue}`
    const remote = (name: string, url: string, extra: string[] = []) => [
      `    - name: ${name}`,
      '      protocol: playwright',
      `      url: ${url}`,
      ...extra,
    ]
    const mirror = ['      headers:', '        X-Mirror: *b']
    const lab = remote('lab', prefix)
    const served = async (avd: string[], remotes: string[]) => {
      const { manager } = await configFile(
        [
          ...WORKSPACE,
          'registry:',
          '  devices:',
          '    pixel:',
          '      platform: android',
          '      capabilities:',
          ...avd,
          '  remotes:',
          ...remotes,
          ...USE.slice(0, -2),
          '    remote: grid',
          ...USE.slice(-2),
          '',
        ].join('\n'),
      )
      const read = await manager.readMasked()
      if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)
      expect(read.fileIssues).toEqual([])
      return read
    }
    const keyed = (key: string) => ['        appium:avd:', `          ? ${key}`, '          : x']

    it('the served config shows that key whole as its origin', async () => {
      const cases = [
        {
          key: `[ &a "${longUrl}", &b ${longUrl} ]`,
          remotes: [...remote('grid', '*a', mirror), ...lab],
          aliased: true,
        },
        {
          key: `[ &a "${midUrl}", [ [ [ [ &b "${midUrl}" ] ] ] ] ]`,
          remotes: [...remote('grid', '*a', mirror), ...lab],
          aliased: true,
        },
        {
          key: `[ &a ${longUrl}, &b "${longUrl}" ]`,
          remotes: [...remote('grid', '*a'), ...remote('mirror', '*b'), ...lab],
          aliased: true,
        },
        {
          key: `[ "${longUrl}", ${longUrl} ]`,
          remotes: [...remote('grid', longUrl), ...lab],
          aliased: false,
        },
      ]
      for (const { key, remotes, aliased } of cases) {
        const read = await served(keyed(key), remotes)
        const registry = read.config.registry as { devices: { pixel: { capabilities: unknown } } }

        expect(registry.devices.pixel.capabilities).toEqual({
          'appium:avd': { 'wss://grid.example.com:443': 'x' },
        })
        const shownText = read.lines.map((line) => line.text).join('\n')
        for (const hidden of [pathPart, queryValue]) {
          expect(JSON.stringify(read.config)).not.toContain(hidden)
          if (aliased) expect(shownText).not.toContain(hidden)
        }
      }
    })

    it('the served config keeps a value that holds the url once, as written, with that url shown by its origin', async () => {
      const read = await served(
        [`        appium:avd: connects to ${longUrl} for the pixel`],
        [...remote('grid', longUrl), ...lab],
      )
      const registry = read.config.registry as { devices: { pixel: { capabilities: unknown } } }

      expect(registry.devices.pixel.capabilities).toEqual({
        'appium:avd': 'connects to wss://grid.example.com:443 for the pixel',
      })
    })
  })

  it('the served config and its file lines hide a url nested under another key of a list entry or of a pairs block', async () => {
    const pathPart = 'routepart-3c58'
    const queryValue = 'queryvalue-e6b2'
    const headerValue = 'headervalue-19fa'
    const url = `wss://grid.example.com/${pathPart}?team=${queryValue}`
    for (const block of ['  remotes:', '  remotes: !!pairs']) {
      const { manager } = await configFile(
        [
          ...WORKSPACE,
          'registry:',
          block,
          `    - grid: { protocol: playwright, url: &u "${url}", headers: { X-Team: ${headerValue} } }`,
          '  devices:',
          '    pixel:',
          '      platform: android',
          '      capabilities:',
          '        appium:avd: *u',
          ...USE,
          '',
        ].join('\n'),
      )
      const read = await manager.readMasked()
      if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

      expect(read.fileIssues).not.toEqual([])
      expect(read.config.registry).toEqual({
        remotes: [{ url: 'invalid url' }],
        devices: {
          pixel: {
            platform: 'android',
            capabilities: { 'appium:avd': 'wss://grid.example.com:443' },
          },
        },
      })
      const text = read.lines.map((line) => line.text).join('\n')
      expect((parseYaml(text, { logLevel: 'error' }) as { registry: unknown }).registry).toEqual({
        remotes: [{ url: 'invalid url' }],
        devices: { pixel: { platform: 'android', capabilities: { 'appium:avd': null } } },
      })
      for (const hidden of [pathPart, queryValue, headerValue, 'X-Team']) {
        expect(JSON.stringify(read.config)).not.toContain(hidden)
        expect(text).not.toContain(hidden)
      }
    }
  })

  it('on a config with no plugins block another package, a path or a second plugins change is refused', async () => {
    await expectRefused(WITHOUT_PLUGINS, [
      [{ op: 'append', path: ['plugins'], value: { name: 'acme', package: '@acme/other-auth' } }],
      [{ op: 'append', path: ['plugins'], value: { name: 'local', path: './local/plugin.js' } }],
      [
        { op: 'append', path: ['plugins'], value: SUBSCRIPTION_AUTH },
        { op: 'set', path: ['plugins'], value: [{ name: 'provider', package: '@acme/provider' }] },
      ],
      [
        { op: 'append', path: ['plugins'], value: SUBSCRIPTION_AUTH },
        { op: 'append', path: ['plugins'], value: SUBSCRIPTION_AUTH },
      ],
    ])
  })

  it('serves a config whose remote url yaml would warn about without printing the warning, and still names a file that does not parse', async () => {
    const { manager } = await configFile(
      [
        ...WORKSPACE,
        'registry:',
        '  llms:',
        '    - name: judge',
        '      provider: anthropic-compatible',
        '      model: m',
        '      baseURL: https://llm.example.com/v1',
        '      providerHeaders:',
        '        ? [ &u !endpoint wss://grid.example.com/routepart-5e21?team=queryvalue-a904 ]',
        '        : x',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        '      url: *u',
        ...USE.slice(0, -2),
        '    remote: grid',
        ...USE.slice(-2),
        '',
      ].join('\n'),
    )
    const broken = await configFile(
      ['registry:', '  remotes: [', '    { url: wss://grid.example.com/'].join('\n'),
    )
    const warned = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      const read = await manager.readMasked()
      if (read.kind !== 'ok') throw new Error(`expected a served config, got ${read.kind}`)

      expect(read.fileIssues).toEqual([])
      const config = read.config.registry as { llms: { providerHeaders: unknown }[] }
      expect(config.llms[0]?.providerHeaders).toEqual({
        '[ &u !endpoint wss://grid.example.com:443 ]': 'x',
      })
      expect((await broken.manager.readMasked()).kind).toBe('file_invalid')
      expect(warned).not.toHaveBeenCalled()
    } finally {
      warned.mockRestore()
    }
  })
})

const FARM_REMOTE = [
  '  remotes:',
  '    - name: farm',
  '      protocol: appium',
  '      url: https://farm.example.com/wd/hub',
  '      headers:',
  '        Authorization: Bearer {{secret:FARM_TOKEN}}',
]

const LOCAL_PIXEL = [
  '    pixel:',
  '      platform: android',
  '      model: Pixel 9',
  '      os: "15"',
]

const WITH_PLACED_DEVICES = [
  ...WORKSPACE,
  'registry:',
  ...FARM_REMOTE,
  '  devices:',
  '    galaxy-farm:',
  '      platform: android',
  '      remote: farm',
  '      capabilities:',
  '        "farm:options":',
  '          accessKey: "{{secret:FARM_KEY}}"',
  ...LOCAL_PIXEL,
  '  targets:',
  '    shop:',
  '      platform: android',
  '      appPackage: com.example.shop',
  '      app:',
  '        path: apps/shop.apk',
  '        ref: https://files.example.com/shop.apk',
  ...USE,
  '',
].join('\n')

const WITH_REMOTE_DEVICE = [
  ...WORKSPACE,
  'registry:',
  ...FARM_REMOTE,
  '  devices:',
  '    galaxy-farm:',
  '      platform: android',
  '      remote: farm',
  ...LOCAL_PIXEL,
  ...USE,
  '',
].join('\n')

describe("a device's placement and a target's app reference", () => {
  it('setting, changing, unsetting, moving or deleting a device remote, its capabilities or an app reference is refused', async () => {
    const pixel = { platform: 'android', model: 'Pixel 9', os: '15' }
    const registry = (parseYaml(WITH_PLACED_DEVICES) as { registry: Record<string, unknown> })
      .registry
    const devices = registry.devices as Record<string, unknown>
    await expectRefused(WITH_PLACED_DEVICES, [
      [{ op: 'set', path: ['registry', 'devices', 'pixel', 'remote'], value: 'farm' }],
      [
        {
          op: 'set',
          path: ['registry', 'devices', 'pixel'],
          value: { ...pixel, remote: 'farm' },
        },
      ],
      [
        {
          op: 'set',
          path: ['registry'],
          value: { ...registry, devices: { ...devices, pixel: { ...pixel, remote: 'farm' } } },
        },
      ],
      [{ op: 'unset', path: ['registry', 'devices', 'galaxy-farm', 'remote'] }],
      [
        {
          op: 'set',
          path: ['registry', 'devices', 'galaxy-farm', 'capabilities', 'farm:options', 'accessKey'],
          value: '{{secret:OTHER_KEY}}',
        },
      ],
      [
        {
          op: 'set',
          path: ['registry', 'devices', 'galaxy-farm', 'capabilities', 'appium:noReset'],
          value: true,
        },
      ],
      [{ op: 'unset', path: ['registry', 'devices', 'galaxy-farm', 'capabilities'] }],
      [
        {
          op: 'set',
          path: ['registry', 'devices', 'pixel', 'capabilities'],
          value: { 'appium:udid': 'emulator-5554' },
        },
      ],
      [{ op: 'unset', path: ['registry', 'devices', 'galaxy-farm'] }],
      [
        {
          op: 'move',
          from: ['registry', 'devices', 'galaxy-farm'],
          path: ['registry', 'devices', 'galaxy-two'],
        },
      ],
      [
        {
          op: 'set',
          path: ['registry', 'targets', 'shop', 'app', 'ref'],
          value: 'https://evil.example.com/shop.apk',
        },
      ],
      [{ op: 'unset', path: ['registry', 'targets', 'shop', 'app', 'ref'] }],
      [{ op: 'unset', path: ['registry', 'targets', 'shop'] }],
      [
        {
          op: 'set',
          path: ['registry', 'targets', 'other'],
          value: { platform: 'android', app: { ref: 'https://evil.example.com/other.apk' } },
        },
      ],
    ])
  })

  it("a local device's model and os are written, and a local device is deleted", async () => {
    const { manager, path } = await configFile(WITH_REMOTE_DEVICE)
    const accepted: ConfigChange[][] = [
      [{ op: 'set', path: ['registry', 'devices', 'pixel', 'model'], value: 'Pixel 9 Pro' }],
      [{ op: 'set', path: ['registry', 'devices', 'pixel', 'os'], value: '16' }],
    ]
    for (const changes of accepted) {
      expect([changes, (await manager.applyChanges(changes)).kind]).toEqual([changes, 'ok'])
    }
    type Written = { registry: { devices: Record<string, unknown> } }
    expect((parseYaml(await readFile(path, 'utf-8')) as Written).registry.devices.pixel).toEqual({
      platform: 'android',
      model: 'Pixel 9 Pro',
      os: '16',
    })

    const deleted = await manager.applyChanges([
      { op: 'unset', path: ['registry', 'devices', 'pixel'] },
    ])
    expect(deleted.kind).toBe('ok')
    expect((parseYaml(await readFile(path, 'utf-8')) as Written).registry.devices).toEqual({
      'galaxy-farm': { platform: 'android', remote: 'farm' },
    })
  })
})
