import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAgentQaVersion, pluginsAddLine } from '@vostride/agent-qa-core'
import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'

import { createPluginCommand, createPluginsCommand } from '../commands/plugins.js'

const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

let workspaceDir: string
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

function objectSchema(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { $schema: DRAFT, type: 'object', properties, additionalProperties: false, ...extra }
}

interface HandMadePlugin {
  version?: string
  manifest?: Record<string, unknown> | null
  options?: Record<string, unknown>
  settings?: Record<string, unknown>
}

// The entry leaves a marker and throws, so a command that ran plugin code shows it.
async function installPlugin(dir: string, name: string, plugin: HandMadePlugin = {}) {
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  const manifest = {
    kind: 'remote',
    runs: 'process',
    protocol: 1,
    entry: './dist/main.js',
    serves: ['playwright'],
    methods: [],
    options: './dist/options.schema.json',
    settings: './dist/settings.schema.json',
    ...plugin.manifest,
  }
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: plugin.version ?? '1.0.0',
      ...(plugin.manifest === null ? {} : { 'agent-qa': { plugin: manifest } }),
    }),
  )
  const marker = JSON.stringify(path.join(workspaceDir, 'plugin-ran.marker'))
  await writeFile(
    path.join(dir, 'dist', 'main.js'),
    `require('node:fs').writeFileSync(${marker}, 'ran')\nthrow new Error('plugin code ran')\n`,
  )
  await writeFile(
    path.join(dir, 'dist', 'options.schema.json'),
    JSON.stringify(plugin.options ?? objectSchema({})),
  )
  await writeFile(
    path.join(dir, 'dist', 'settings.schema.json'),
    JSON.stringify(plugin.settings ?? objectSchema({})),
  )
}

async function installPackage(name: string, plugin: HandMadePlugin = {}) {
  await installPlugin(path.join(workspaceDir, 'node_modules', ...name.split('/')), name, plugin)
}

const WORKSPACE = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
]

async function writeConfig(lines: {
  plugins: readonly string[]
  remotes: readonly [string, string][]
}): Promise<void> {
  await writeFile(
    path.join(workspaceDir, 'agent-qa.config.yaml'),
    [
      ...WORKSPACE,
      ...(lines.remotes.length === 0 ? [] : ['registry:', '  remotes:']),
      ...lines.remotes.flatMap(([remote, entry]) => [
        `    - name: ${remote}`,
        `      plugin: ${entry}`,
      ]),
      'plugins:',
      ...lines.plugins,
      '',
    ].join('\n'),
  )
}

async function runCli(...args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(createPluginsCommand())
  program.addCommand(createPluginCommand())
  await program.parseAsync([
    'node',
    'agent-qa',
    '--config',
    path.join(workspaceDir, 'agent-qa.config.yaml'),
    ...args,
  ])
}

async function runPlugins(...args: string[]): Promise<void> {
  await runCli('plugins', ...args)
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function stdout(): string {
  return stripAnsi(logSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n'))
}

function stderr(): string {
  return stripAnsi(errorSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n'))
}

function jsonOut(): unknown {
  return JSON.parse(stdout())
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(tmpdir(), 'agent-qa-plugins-command-'))
  await writeFile(path.join(workspaceDir, 'hooks.yaml'), 'hooks: []\n')
  await writeFile(path.join(workspaceDir, '.env'), '')
  await writeFile(path.join(workspaceDir, '.env.secrets.local'), '')
  process.exitCode = 0
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
  process.exitCode = 0
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('agent-qa plugins list', () => {
  const version = getAgentQaVersion()
  const firstParty = '@vostride/agent-qa-plugin-scripted'
  const missing = '@vostride/agent-qa-plugin-absent'

  beforeEach(async () => {
    await installPackage('@acme/agent-qa-plugin-grid')
    await installPackage(firstParty, { version: '0.0.1' })
    await installPackage('@acme/agent-qa-plugin-future', { manifest: { protocol: 9 } })
    await installPackage('@acme/agent-qa-plugin-broken', { manifest: null })
    await installPackage('@acme/agent-qa-plugin-spare')
    await installPlugin(path.join(workspaceDir, 'tools', 'local'), 'local-plugin')
    await writeConfig({
      plugins: [
        '  - name: grid',
        "    package: '@acme/agent-qa-plugin-grid'",
        '  - name: absent',
        `    package: '${missing}'`,
        '  - name: old',
        `    package: '${firstParty}'`,
        '  - name: future',
        "    package: '@acme/agent-qa-plugin-future'",
        '  - name: broken',
        "    package: '@acme/agent-qa-plugin-broken'",
        '  - name: spare',
        "    package: '@acme/agent-qa-plugin-spare'",
        '  - name: local',
        '    path: ./tools/local',
      ],
      remotes: [
        ['farm', 'grid'],
        ['lab', 'grid'],
        ['gone', 'absent'],
        ['stale', 'old'],
        ['next', 'future'],
        ['bad', 'broken'],
        ['near', 'local'],
      ],
    })
  })

  // The run names its config with --config from another folder, so the line carries it.
  const install = (name: string) =>
    pluginsAddLine(name, path.join(workspaceDir, 'agent-qa.config.yaml'))
  const reasons = (): Record<string, string> => ({
    absent:
      `Plugin entry absent names ${missing}, which is not installed. Run ${install(missing)}.`,
    old:
      `Plugin entry old names ${firstParty} at 0.0.1, and agent-qa is at ${version}. `
      + `Run ${install(firstParty)}.`,
    future:
      'Plugin entry future names @acme/agent-qa-plugin-future, which speaks plugin protocol 9, '
      + "newer than this agent-qa's 1. Update agent-qa.",
    broken:
      'Plugin entry broken names @acme/agent-qa-plugin-broken, whose package.json has no valid '
      + "agent-qa plugin manifest (agent-qa.plugin is missing). Fix the plugin's manifest.",
    spare:
      'Plugin entry spare is used by no remote. Name it from a remote in registry.remotes, or '
      + 'remove it.',
  })

  const acme = (id: string) => `@acme/agent-qa-plugin-${id}`
  const rows = [
    ['ok', 'grid', acme('grid'), 'third-party', '1.0.0', '1', 'farm, lab'],
    ['ok', 'local', './tools/local', 'path', '1.0.0', '1', 'near'],
    ['not_installed', 'absent', missing, 'first-party', '-', '-', 'gone'],
    ['version_mismatch', 'old', firstParty, 'first-party', '0.0.1', '-', 'stale'],
    ['protocol_mismatch', 'future', acme('future'), 'third-party', '1.0.0', '9', 'next'],
    ['bad_manifest', 'broken', acme('broken'), 'third-party', '1.0.0', '-', 'bad'],
    ['unused', 'spare', acme('spare'), 'third-party', '1.0.0', '1', 'none'],
  ] as const

  it.each(rows)(
    'prints a %s entry (%s) with its reason on the next line',
    async (state, name, label, origin, at, protocol, remotes) => {
      await runPlugins('list')

      const lines = stdout().split('\n')
      const index = lines.indexOf(
        `${name}  ${label}  ${origin}  ${at}  protocol ${protocol}  remotes: ${remotes}  ${state}`,
      )
      expect(index).toBeGreaterThanOrEqual(0)
      if (state === 'ok') expect(lines[index + 1]?.startsWith('  ')).not.toBe(true)
      else expect(lines[index + 1]).toBe(`  ${reasons()[name]}`)
      expect(process.exitCode).toBe(0)
    },
  )

  it.each(rows)('emits a %s entry (%s) as JSON', async (state, name) => {
    await runPlugins('list', '--json')

    const { plugins } = jsonOut() as { plugins: Record<string, unknown>[] }
    const row = plugins.find((plugin) => plugin.name === name)
    expect(row?.state).toBe(state)
    expect(row?.reason).toBe(reasons()[name])
    expect(process.exitCode).toBe(0)
  })

  it('emits each entry with its declaration, origin, version, protocol, remotes, fix', async () => {
    await runPlugins('list', '--json')

    const { plugins } = jsonOut() as { plugins: Record<string, unknown>[] }
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      'grid',
      'absent',
      'old',
      'future',
      'broken',
      'spare',
      'local',
    ])
    expect(plugins[0]).toEqual({
      name: 'grid',
      package: '@acme/agent-qa-plugin-grid',
      origin: 'third-party',
      version: '1.0.0',
      protocol: 1,
      remotes: ['farm', 'lab'],
      state: 'ok',
    })
    expect(plugins[1]).toEqual({
      name: 'absent',
      package: missing,
      origin: 'first-party',
      remotes: ['gone'],
      state: 'not_installed',
      reason: reasons().absent,
      install: install(missing),
    })
    expect(plugins[2]?.install).toBe(install(firstParty))
    expect(plugins[6]).toEqual({
      name: 'local',
      path: './tools/local',
      origin: 'path',
      version: '1.0.0',
      protocol: 1,
      remotes: ['near'],
      state: 'ok',
    })
  })

  it('lists packages whose entry throws on import without running them', async () => {
    await runPlugins('list')
    await runPlugins('list', '--json')

    expect(existsSync(path.join(workspaceDir, 'plugin-ran.marker'))).toBe(false)
    expect(stderr()).toBe('')
    expect(process.exitCode).toBe(0)
  })
})

describe('agent-qa plugins list without entries or config', () => {
  it('says plugins lists no entries', async () => {
    await writeFile(path.join(workspaceDir, 'agent-qa.config.yaml'), [...WORKSPACE, ''].join('\n'))

    await runPlugins('list')

    expect(stdout()).toBe('plugins lists no entries.')
    expect(process.exitCode).toBe(0)
  })

  it('reports a config that does not resolve and exits 1', async () => {
    await writeFile(path.join(workspaceDir, 'agent-qa.config.yaml'), 'plugins: 7\n')

    await runPlugins('list', '--json')

    expect(stdout()).toBe('')
    expect(stderr()).toMatch(/^Config validation failed:/)
    expect(process.exitCode).toBe(1)
  })
})

describe('agent-qa plugins describe', () => {
  beforeEach(async () => {
    await installPackage('@acme/agent-qa-plugin-grid', {
      manifest: {
        serves: ['playwright', 'cdp'],
        methods: ['check'],
        runFacts: ['testName', 'runId', 'failure'],
        skill: './skill',
      },
      options: objectSchema(
        {
          apiKey: { type: 'string', credential: true, description: 'The account key' },
          apiUrl: {
            type: 'string',
            default: 'https://api.acme.test',
            description: 'The API endpoint',
          },
        },
        { required: ['apiKey'] },
      ),
      settings: objectSchema({
        region: { type: 'string', enum: ['eu', 'us'], description: 'Where sessions run' },
      }),
    })
    await installPackage('@acme/agent-qa-plugin-spare')
    await writeConfig({
      plugins: [
        '  - name: grid',
        "    package: '@acme/agent-qa-plugin-grid'",
        '  - name: spare',
        "    package: '@acme/agent-qa-plugin-spare'",
      ],
      remotes: [['farm', 'grid']],
    })
  })

  it('prints what the plugin serves, its methods and run facts, then its fields', async () => {
    await runPlugins('describe', 'grid')

    const lines = stdout().split('\n')
    expect(lines.slice(0, 5)).toEqual([
      'grid  @acme/agent-qa-plugin-grid  third-party  1.0.0  protocol 1',
      'serves: playwright, cdp',
      'methods: check',
      'receives: testName, runId, failure',
      'skill: ./skill',
    ])
    const options = lines.indexOf('Options')
    const settings = lines.indexOf('Settings')
    expect(options).toBeGreaterThan(4)
    expect(settings).toBeGreaterThan(options)
    const optionRows = lines.slice(options + 1, settings)
    expect(optionRows[0]).toMatch(
      /^\s+field\s+type\s+required\s+default\s+credential\s+description$/,
    )
    expect(optionRows[1]).toMatch(
      /^\s+apiKey\s+string\s+required\s+-\s+credential\s+The account key$/,
    )
    expect(optionRows[2]).toMatch(
      /^\s+apiUrl\s+string\s+optional\s+"https:\/\/api\.acme\.test"\s+-\s+The API endpoint$/,
    )
    expect(lines[settings + 2]).toMatch(
      /^\s+region\s+'eu' \| 'us'\s+optional\s+-\s+-\s+Where sessions run$/,
    )
    expect(existsSync(path.join(workspaceDir, 'plugin-ran.marker'))).toBe(false)
    expect(process.exitCode).toBe(0)
  })

  it('says a plugin that declares no run facts receives session facts only', async () => {
    await runPlugins('describe', 'spare')

    expect(stdout().split('\n')).toContain('receives: session facts only')
    expect(stdout().split('\n')).toContain('methods: none')
  })

  it('emits the same description as JSON', async () => {
    await runPlugins('describe', 'grid', '--json')

    expect(jsonOut()).toEqual({
      entry: 'grid',
      package: '@acme/agent-qa-plugin-grid',
      origin: 'third-party',
      version: '1.0.0',
      protocol: 1,
      serves: ['playwright', 'cdp'],
      methods: ['check'],
      runFacts: ['testName', 'runId', 'failure'],
      skill: './skill',
      options: [
        {
          path: 'apiKey',
          type: 'string',
          required: true,
          description: 'The account key',
          credential: true,
        },
        {
          path: 'apiUrl',
          type: 'string',
          required: false,
          default: 'https://api.acme.test',
          description: 'The API endpoint',
          credential: false,
        },
      ],
      settings: [
        {
          path: 'region',
          type: "'eu' | 'us'",
          required: false,
          description: 'Where sessions run',
          credential: false,
        },
      ],
    })
    expect(process.exitCode).toBe(0)
  })

  it.each([[[]], [['--json']]])('refuses an unknown entry name and exits 1 (%j)', async (flags) => {
    await runPlugins('describe', 'nope', ...flags)

    expect(stdout()).toBe('')
    expect(stderr()).toBe('No plugins entry named nope. plugins lists: grid, spare.')
    expect(process.exitCode).toBe(1)
  })

  it('refuses an entry whose package is not installed with its plugins add line', async () => {
    await writeConfig({
      plugins: ['  - name: absent', "    package: '@acme/agent-qa-plugin-absent'"],
      remotes: [],
    })

    await runPlugins('describe', 'absent')

    const install = pluginsAddLine(
      '@acme/agent-qa-plugin-absent',
      path.join(workspaceDir, 'agent-qa.config.yaml'),
    )
    expect(install).toMatch(/^npx agent-qa --config \S+ plugins add @acme\/agent-qa-plugin-absent$/u)
    expect(stderr()).toBe(
      'Plugin entry absent names @acme/agent-qa-plugin-absent, which is not installed. '
        + `Run ${install}.`,
    )
    expect(process.exitCode).toBe(1)
  })
})

describe('agent-qa plugin validate', () => {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const statusLine = (status: string, name: string, detail?: string) =>
    new RegExp(`^${status}\\s+${name}${detail === undefined ? '' : `\\s+${escape(detail)}`}$`, 'm')
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    process.chdir(workspaceDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  function scripted(dir = path.join(workspaceDir, 'tools', 'scripted')): string {
    return writeScriptedPlugin(dir).dir
  }

  async function validate(target: string, ...flags: string[]): Promise<void> {
    await runCli('plugin', 'validate', target, ...flags)
  }

  it('passes the scripted plugin on every check and exits 0', async () => {
    scripted()

    await validate('./tools/scripted')

    for (const name of [
      'manifest',
      'schemas',
      'credential-marks',
      'skill',
      'package',
      'handshake',
      'unknown-method',
      'clean-stdout',
      'exit-on-stdin-close',
    ]) {
      expect(stdout()).toMatch(statusLine('ok', name))
    }
    expect(stdout()).not.toMatch(/^(warn|fail)/m)
    expect(process.exitCode).toBe(0)
  })

  it('emits the checks as JSON', async () => {
    scripted()

    await validate('./tools/scripted', '--json')

    const report = jsonOut() as { ok: boolean; checks: { name: string; ok: boolean }[] }
    expect(report.ok).toBe(true)
    expect(report.checks.map((check) => check.name)).toEqual([
      'manifest',
      'schemas',
      'credential-marks',
      'skill',
      'package',
      'handshake',
      'unknown-method',
      'clean-stdout',
      'exit-on-stdin-close',
    ])
    expect(process.exitCode).toBe(0)
  })

  it('finds an installed package from the config folder', async () => {
    scripted(path.join(workspaceDir, 'node_modules', '@acme', 'agent-qa-plugin-scripted'))
    await mkdir(path.join(workspaceDir, 'elsewhere'))
    process.chdir(path.join(workspaceDir, 'elsewhere'))

    await validate('@acme/agent-qa-plugin-scripted')

    expect(stdout()).toMatch(statusLine('ok', 'manifest'))
    expect(process.exitCode).toBe(0)
  })

  it('fails a skill folder that holds code', async () => {
    const dir = scripted()
    await writeFile(path.join(dir, 'skill', 'run.sh'), 'echo hi\n')

    await validate(dir)

    expect(stdout()).toMatch(
      statusLine('fail', 'skill', 'the skill folder holds code (run.sh); a skill is plain files'),
    )
    expect(process.exitCode).toBe(1)
  })

  it('fails a SKILL.md without a description', async () => {
    const dir = scripted()
    await writeFile(path.join(dir, 'skill', 'SKILL.md'), '---\nname: scripted\n---\n\n# Scripted\n')

    await validate(dir)

    expect(stdout()).toMatch(
      statusLine('fail', 'skill', 'skill/SKILL.md has no description in its frontmatter'),
    )
    expect(process.exitCode).toBe(1)
  })

  it('warns about a credential-looking option with no credential mark and exits 0', async () => {
    const dir = scripted()
    await writeFile(
      path.join(dir, 'options.schema.json'),
      JSON.stringify({ $schema: DRAFT, type: 'object', properties: { token: { type: 'string' } } }),
    )

    await validate(dir)

    expect(stdout()).toMatch(
      statusLine(
        'warn',
        'credential-marks',
        'options.token looks like a credential and has no credential mark; mark it with '
          + 'credential() so config must hold a {{secret:NAME}} reference',
      ),
    )
    expect(stdout()).not.toMatch(/^fail/m)
    expect(process.exitCode).toBe(0)
  })

  it('warns about install scripts, an agent-qa peer dependency and a missing keyword', async () => {
    const dir = scripted()
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        ...pkg,
        keywords: [],
        scripts: { postinstall: 'node setup.js' },
        peerDependencies: { 'agent-qa': '*' },
      }),
    )

    await validate(dir)

    expect(stdout()).toMatch(
      statusLine(
        'warn',
        'package',
        'package.json runs postinstall on install; a plugin installs with no scripts; '
          + 'package.json lists agent-qa in peerDependencies; agent-qa checks a plugin by its '
          + 'protocol, not peerDependencies; package.json keywords lack agent-qa-plugin, which npm '
          + 'search finds plugins by',
      ),
    )
    expect(process.exitCode).toBe(0)
  })

  it('fails a schema that does not name draft 2020-12', async () => {
    const dir = scripted()
    await writeFile(
      path.join(dir, 'settings.schema.json'),
      JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }),
    )

    await validate(dir)

    expect(stdout()).toMatch(
      statusLine(
        'fail',
        'schemas',
        './settings.schema.json names http://json-schema.org/draft-07/schema#, not JSON Schema '
          + 'draft 2020-12',
      ),
    )
    expect(process.exitCode).toBe(1)
  })

  it('fails clean-stdout for a plugin that prints to stdout, and never acquires', async () => {
    const dir = writeScriptedPlugin(path.join(workspaceDir, 'tools', 'noisy'), {
      serves: ['cdp'],
      methods: [],
    }).dir
    const ledger = path.join(workspaceDir, 'noisy.ledger')
    await writeFile(
      path.join(dir, 'main.mjs'),
      [
        "import { appendFileSync } from 'node:fs'",
        "import { createInterface } from 'node:readline'",
        "process.stdout.write('hello\\n')",
        "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')",
        'const lines = createInterface({ input: process.stdin })',
        "lines.on('line', (line) => {",
        '  const message = JSON.parse(line)',
        '  if (message.id === undefined) return',
        `  appendFileSync(${JSON.stringify(ledger)}, message.method + '\\n')`,
        "  if (message.method === 'initialize') {",
        "    const plugin = { name: 'noisy', version: '1.0.0' }",
        "    const result = { protocolVersion: 1, plugin, serves: ['cdp'], methods: [] }",
        '    return send({ id: message.id, result })',
        '  }',
        "  send({ id: message.id, error: { code: -32601, message: 'no ' + message.method } })",
        '})',
        "lines.on('close', () => process.exit(0))",
        '',
      ].join('\n'),
    )

    await validate(dir)

    expect(stdout()).toMatch(/^fail\s+clean-stdout\s+.*hello$/m)
    expect(stdout()).toMatch(statusLine('ok', 'handshake'))
    expect(readFileSync(ledger, 'utf8')).not.toContain('acquire')
    expect(process.exitCode).toBe(1)
  })

  it('prints the plugins add line for a package that is not installed and exits 1', async () => {
    await validate('@acme/agent-qa-plugin-absent')

    expect(stdout()).toMatch(
      statusLine(
        'fail',
        'package',
        '@acme/agent-qa-plugin-absent is not installed in this project. Run npx agent-qa '
          + 'plugins add @acme/agent-qa-plugin-absent.',
      ),
    )
    expect(process.exitCode).toBe(1)
  })

  it('prints no plugins add line for a target that is not an npm package name', async () => {
    await validate('$(id)')

    expect(stdout()).toContain('$(id) is not an npm package name or a folder')
    expect(stdout()).not.toContain('plugins add')
    expect(process.exitCode).toBe(1)
  })
})
