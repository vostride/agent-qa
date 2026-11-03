import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { ConfigChange } from '@vostride/agent-qa-schema'

import { ConfigManager } from '../index.js'

const SUBSCRIPTION_AUTH = { package: '@vostride/agent-qa-subscription-auth' }

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
  '  auth:',
  '    - path: ./auth-plugin.mjs',
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
      [{ op: 'set', path: ['plugins', 'providers'], value: [{ package: '@acme/provider' }] }],
      [{ op: 'append', path: ['plugins', 'auth'], value: { package: '@acme/other-auth' } }],
      [{ op: 'set', path: ['plugins', 'auth', 0, 'path'], value: './other-plugin.mjs' }],
      [{ op: 'unset', path: ['plugins'] }],
    ])
  })

  it('the subscription-auth append, the remote pick and unrelated fields are written', async () => {
    const { manager, path } = await configFile(WITH_PLUGINS)
    const accepted: ConfigChange[][] = [
      [{ op: 'append', path: ['plugins', 'auth'], value: SUBSCRIPTION_AUTH }],
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
    expect(written.plugins).toEqual({ auth: [{ path: './auth-plugin.mjs' }, SUBSCRIPTION_AUTH] })
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

  it('on a config with no plugins block the subscription-auth append creates plugins.auth with that one entry', async () => {
    const { manager, path } = await configFile(WITHOUT_PLUGINS)
    const outcome = await manager.applyChanges([
      { op: 'append', path: ['plugins', 'auth'], value: SUBSCRIPTION_AUTH },
    ])
    expect(outcome).toMatchObject({ kind: 'ok' })
    expect((parseYaml(await readFile(path, 'utf-8')) as { plugins: unknown }).plugins)
      .toEqual({ auth: [SUBSCRIPTION_AUTH] })
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

  it('on a config with no plugins block another package, a path or a second plugins change is refused', async () => {
    await expectRefused(WITHOUT_PLUGINS, [
      [{ op: 'append', path: ['plugins', 'auth'], value: { package: '@acme/other-auth' } }],
      [{ op: 'append', path: ['plugins', 'auth'], value: { path: './local/plugin.js' } }],
      [
        { op: 'append', path: ['plugins', 'auth'], value: SUBSCRIPTION_AUTH },
        { op: 'set', path: ['plugins', 'providers'], value: [{ package: '@acme/provider' }] },
      ],
      [
        { op: 'append', path: ['plugins', 'auth'], value: SUBSCRIPTION_AUTH },
        { op: 'append', path: ['plugins', 'auth'], value: SUBSCRIPTION_AUTH },
      ],
    ])
  })
})
