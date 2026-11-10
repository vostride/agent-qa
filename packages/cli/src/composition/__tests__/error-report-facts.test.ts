// What a report says about where agent-qa ran is read from commander and the raw config document:
// names and closed values only, never a flag's value, a positional argument, a path or a package
// name outside the first-party plugins.

import { Command, Option } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectReportFacts } from '../error-report-facts.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

// Shaped like the real tree: root options before the command, a group, and a leaf with options of
// every kind and a positional argument.
async function actionOf(args: readonly string[]): Promise<Command> {
  let ran: Command | undefined
  const root = new Command('agent-qa')
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .enablePositionalOptions()
    .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
    .option('--log-level <level>', 'log verbosity')
  root
    .command('daemon')
    .command('status')
    .argument('[name]')
    .option('-j, --json', 'print JSON')
    .option('--port <port>', 'port', '7357')
    .option('--headless', 'headless')
    .option('--no-headless', 'headed')
    .addOption(new Option('--token <token>').env('FACTS_CELL_TOKEN'))
    .action((_name: unknown, _options: unknown, command: Command) => {
      ran = command
    })
  await root.parseAsync(['node', 'agent-qa', ...args])
  if (ran === undefined) throw new Error('the leaf action did not run')
  return ran
}

const factsOf = (action: Command, document?: unknown, env: NodeJS.ProcessEnv = {}) =>
  collectReportFacts({ action, document, env })

describe('the command and its flags', () => {
  it('names the command path and the flags typed, and no flag value or positional argument', async () => {
    const action = await actionOf([
      '--config',
      'other-config-canary.yaml',
      '--log-level=debug-canary',
      'daemon',
      'status',
      'positional-canary',
      '--json',
    ])

    const facts = factsOf(action)

    expect(facts.command).toBe('daemon status')
    expect(facts.flags).toEqual(['--config', '--json', '--log-level'])
    const text = JSON.stringify(facts)
    for (const value of ['other-config-canary', 'debug-canary', 'positional-canary', '7357']) {
      expect(text).not.toContain(value)
    }
  })

  it('leaves out a flag left at its default or set from the environment, and names a short flag by its long name', async () => {
    vi.stubEnv('FACTS_CELL_TOKEN', 'env-token-canary')
    const action = await actionOf(['daemon', 'status', '-j'])

    const facts = factsOf(action)

    expect(facts.flags).toEqual(['--json'])
    expect(JSON.stringify(facts)).not.toContain('env-token-canary')
  })

  it('names the one of a --no- pair that was typed', async () => {
    expect(factsOf(await actionOf(['daemon', 'status', '--no-headless'])).flags).toEqual([
      '--no-headless',
    ])
    expect(factsOf(await actionOf(['daemon', 'status', '--headless'])).flags).toEqual([
      '--headless',
    ])
  })
})

describe('the package manager', () => {
  it('is the manager the user agent names, and unknown when the variable is absent or names another tool', async () => {
    const action = await actionOf(['daemon', 'status'])
    const managerFor = (agent: string | undefined) =>
      factsOf(action, undefined, agent === undefined ? {} : { npm_config_user_agent: agent })
        .packageManager

    expect(managerFor('pnpm/10.20.0 npm/? node/v24.0.0 darwin arm64')).toBe('pnpm')
    expect(managerFor('npm/11.6.0 node/v24.0.0 linux x64 workspaces/false')).toBe('npm')
    expect(managerFor('yarn/4.5.0 npm/? node/v24.0.0 darwin arm64')).toBe('yarn')
    expect(managerFor('bun/1.3.0 npm/? node/v24.0.0 linux x64')).toBe('bun')
    expect(managerFor('deno/2.5.0 npm/? node/v24.0.0 linux x64')).toBe('unknown')
    expect(managerFor(undefined)).toBe('unknown')
  })
})

describe('CI or local', () => {
  it('is CI when the CI variable is set, and local when it is not', async () => {
    const action = await actionOf(['daemon', 'status'])

    vi.stubEnv('CI', 'true')
    expect(factsOf(action).ci).toBe(true)
    vi.stubEnv('CI', 'false')
    expect(factsOf(action).ci).toBe(false)
  })
})

describe('the configured platforms, models and plugins', () => {
  it('are the distinct target platforms, provider/model pairs and plugin ids of the raw config, sorted', async () => {
    const action = await actionOf(['daemon', 'status'])
    const document = {
      registry: {
        targets: {
          shop: { platform: 'web', url: 'https://shop-canary.example' },
          admin: { platform: 'web', url: 'https://admin-canary.example' },
          phone: { platform: 'android', appPackage: 'com.canary.app' },
          desk: { platform: 'desktop' },
        },
        llms: [
          { name: 'main', provider: 'openai-compatible', model: 'gpt-y', baseURL: 'http://x' },
          { name: 'second', provider: 'anthropic-compatible', model: 'claude-x' },
          { name: 'again', provider: 'openai-compatible', model: 'gpt-y' },
          { name: 'broken', provider: 42, model: 'no-provider' },
        ],
      },
      plugins: [
        { name: 'kernel', package: '@vostride/agent-qa-plugin-kernel' },
        { name: 'private', package: '@acme-canary/agent-qa-plugin-private' },
        { name: 'local', path: './plugins/local-canary' },
        'not-an-entry',
      ],
    }

    const facts = factsOf(action, document)

    expect(facts.platforms).toEqual(['android', 'web'])
    expect(facts.models).toEqual(['anthropic-compatible/claude-x', 'openai-compatible/gpt-y'])
    expect(facts.plugins).toEqual(['kernel', 'third_party'])
    expect(JSON.stringify(facts)).not.toMatch(/canary|desktop|no-provider/)
  })

  it('are empty lists for a document of another shape, or none, and reading one never throws', async () => {
    const action = await actionOf(['daemon', 'status'])
    const documents: unknown[] = [
      undefined,
      null,
      'registry: text',
      42,
      [],
      { registry: [], plugins: {} },
      { registry: { targets: [{ platform: 'web' }], llms: { provider: 'p', model: 'm' } } },
      { registry: { targets: 'web', llms: 'p/m' }, plugins: 'kernel' },
      { registry: { targets: { web: null, phone: 'android' }, llms: [null, 'p/m'] }, plugins: [7] },
    ]

    for (const document of documents) {
      expect(factsOf(action, document)).toMatchObject({ platforms: [], models: [], plugins: [] })
    }
  })
})
