import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Command } from 'commander'
import { stringify } from 'yaml'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import {
  startLoopbackFake,
  writeScriptedPlugin,
  type ScriptedPluginInput,
} from '@vostride/agent-qa-plugin-kit/testing'

import { writeInstalledPackage } from './project-fixtures.js'
import { pinProcessTmpdir, removeTempRoots, type PinnedTmpdir } from './temp-roots.js'

vi.mock('@vostride/agent-qa-runner-local', () => ({
  checkDockerAvailable: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../commands/doctor-knowledge-checks.js', () => ({
  createKnowledgeChecks: () => [],
}))

vi.mock('../provider-plugins.js', () => ({
  loadProviderPluginsForRawConfig: vi.fn(() => Promise.resolve()),
}))

vi.mock('@vostride/agent-qa-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-core')>()),
  resolveLLMAuth: vi.fn(() =>
    Promise.resolve({
      kind: 'unauthenticated',
      credentialKey: 'default',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    }),
  ),
  validateProject: vi.fn(() =>
    Promise.resolve({ errorCount: 0, warningCount: 0, fileCount: 1, results: [] }),
  ),
}))

vi.mock('@vostride/agent-qa-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-model')>()),
  createModel: vi.fn(() => ({})),
}))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
}))

import { createDoctorCommand } from '../commands/doctor.js'
import { createPluginChecks, type PluginChecksInput } from '../commands/doctor-plugin-checks.js'

const FIRST_PARTY = '@vostride/agent-qa-plugin-scripted'
const SECRET_VALUE = 'lab-secret-value-91c2'

interface Row {
  name: string
  status: string
  message: string
  fix?: string
}

interface Project {
  dir: string
  configPath: string
  ledger: string
  secretsFile: { configuredPath: string; absolutePath: string }
}

let pinned: PinnedTmpdir
let printed: string[]
let consoleSpies: { mockRestore(): void }[] = []

async function newProject(secrets = ''): Promise<Project> {
  const dir = await mkdtemp(join(pinned.root, 'project-'))
  await writeFile(join(dir, 'hooks.yaml'), 'hooks: []\n')
  await writeFile(join(dir, '.env'), '')
  await writeFile(join(dir, '.env.secrets.local'), secrets)
  await mkdir(join(dir, 'tests'), { recursive: true })
  await mkdir(join(dir, 'suites'), { recursive: true })
  await writeFile(
    join(dir, 'tests', 'home.yaml'),
    stringify({ name: 'Home', target: 'web', steps: ['Open'] }),
  )
  return {
    dir,
    configPath: join(dir, 'agent-qa.config.yaml'),
    ledger: join(dir, 'plugin.ledger.jsonl'),
    secretsFile: {
      configuredPath: '.env.secrets.local',
      absolutePath: join(dir, '.env.secrets.local'),
    },
  }
}

function installFirstParty(project: Project, input: ScriptedPluginInput = {}): void {
  writeScriptedPlugin(join(project.dir, 'node_modules', ...FIRST_PARTY.split('/')), {
    packageName: FIRST_PARTY,
    version: getAgentQaVersion(),
    ...input,
  })
}

function config(
  plugins: readonly Record<string, unknown>[],
  remotes: readonly Record<string, unknown>[],
  registry: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    registry: {
      llms: [
        {
          name: 'default',
          provider: 'openai-compatible',
          model: 'model-name',
          baseURL: 'https://llm.example/api/v1',
        },
      ],
      targets: { web: { platform: 'web', url: 'https://app.example' } },
      remotes,
      ...registry,
    },
    use: { llm: 'default', browser: { name: 'chromium', headless: true, remote: 'farm' } },
    plugins,
  }
}

async function rows(
  project: Project,
  raw: Record<string, unknown>,
  extra: Partial<PluginChecksInput> = {},
): Promise<Row[]> {
  const found: Row[] = []
  for (const check of createPluginChecks({
    config: raw,
    configDir: project.dir,
    secretsFile: project.secretsFile,
    ...extra,
  })) {
    found.push({ name: check.name, ...(await check.check()) })
  }
  return found
}

function ledgerMethods(project: Project): string[] {
  if (!existsSync(project.ledger)) return []
  return readFileSync(project.ledger, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { method: string }).method)
}

// Speaks the protocol by hand; its check asks the vendor named in its options, as a real one would.
function writeVendorPlugin(dir: string): void {
  writeScriptedPlugin(dir, {
    packageName: '@acme/agent-qa-plugin-vendor',
    serves: ['playwright'],
    methods: ['check'],
  })
  writeFileSync(
    join(dir, 'main.mjs'),
    `let options = {}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
async function answer(message) {
  if (message.method === 'initialize') {
    options = message.params.options
    return { protocolVersion: 1, plugin: { name: 'vendor', version: '1.0.0' }, serves: ['playwright'], methods: ['check'] }
  }
  if (message.method === 'check') {
    const reply = await fetch(options.vendor + '/v1/plan')
    return { state: 'ok', lines: [(await reply.json()).line] }
  }
  return {}
}
let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('end', () => process.exit(0))
process.stdin.on('data', (chunk) => {
  pending += chunk
  for (let end = pending.indexOf('\\n'); end >= 0; end = pending.indexOf('\\n')) {
    const line = pending.slice(0, end)
    pending = pending.slice(end + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.id !== undefined) answer(message).then((result) => send({ id: message.id, result }))
  }
})
`,
  )
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

async function runDoctorJson(
  project: Project,
  raw: Record<string, unknown>,
  ...globalArgs: string[]
) {
  await writeFile(project.configPath, stringify(raw))
  printed = []
  process.exitCode = 0
  const program = new Command()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.option('--log-level <level>')
  program.addCommand(
    createDoctorCommand({
      chromium: () => ({ found: true, path: '/browsers/chromium-1/chrome' }),
      listDevicesHere: async (platform) =>
        platform === 'android' ? { attached: [], avds: [] } : { simulators: [] },
    }),
  )
  await program.parseAsync([
    'node',
    'agent-qa',
    '--config',
    project.configPath,
    ...globalArgs,
    'doctor',
    '--json',
  ])
  return JSON.parse(printed.join('\n')) as { format: number; ok: boolean; rows: Row[] }
}

describe("doctor's plugin rows", () => {
  beforeAll(() => {
    pinned = pinProcessTmpdir()
  })

  afterAll(() => {
    pinned.restore()
    removeTempRoots([pinned.root])
  })

  beforeEach(() => {
    printed = []
    consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
        printed.push(parts.map(String).join(' '))
      }),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
  })

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore()
    process.exitCode = 0
  })

  it("shows a first-party plugin's package, origin, version, protocol, run facts and remotes, and passes its account check without asking for a session", async () => {
    const project = await newProject()
    installFirstParty(project)
    const raw = config(
      [{ name: 'lab', package: FIRST_PARTY, options: { ledgerFile: project.ledger } }],
      [{ name: 'farm', plugin: 'lab' }],
    )

    const found = await rows(project, raw)

    expect(found).toEqual([
      {
        name: 'Plugin lab',
        status: 'pass',
        message:
          `${FIRST_PARTY}, first-party, version ${getAgentQaVersion()}, protocol 1; `
          + 'receives session facts only; remotes farm; the account check passed',
      },
    ])
    expect(ledgerMethods(project)).toEqual(['initialize', 'check', 'shutdown'])
  })

  it('names the run facts a plugin declares it receives', async () => {
    const project = await newProject()
    writeScriptedPlugin(join(project.dir, 'plugins', 'facts'), {
      runFacts: ['testName', 'runId', 'failure'],
      methods: [],
    })
    const raw = config(
      [{ name: 'facts', path: './plugins/facts' }],
      [{ name: 'farm', plugin: 'facts' }],
    )

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('pass')
    expect(row?.message).toContain('path, version 1.0.0, protocol 1')
    expect(row?.message).toContain('receives testName, runId, failure')
  })

  it('warns with the lines of an account check that answers warn', async () => {
    const project = await newProject()
    installFirstParty(project)
    const raw = config(
      [
        {
          name: 'lab',
          package: FIRST_PARTY,
          options: { check: { state: 'warn', lines: ['2 of 5 sessions free'] } },
        },
      ],
      [{ name: 'farm', plugin: 'lab' }],
    )

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('warn')
    expect(row?.message).toMatch(/; 2 of 5 sessions free$/)
  })

  it('warns, and never fails, with the line of a refused account check', async () => {
    const project = await newProject()
    installFirstParty(project)
    const raw = config(
      [
        {
          name: 'lab',
          package: FIRST_PARTY,
          options: {
            script: { check: { error: { kind: 'auth', message: 'the lab key was rejected' } } },
          },
        },
      ],
      [{ name: 'farm', plugin: 'lab' }],
    )

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('the lab key was rejected')
  })

  it('masks declared secret values in the account check lines', async () => {
    const project = await newProject(`LAB_KEY=${SECRET_VALUE}\n`)
    installFirstParty(project)
    const raw = config(
      [
        {
          name: 'lab',
          package: FIRST_PARTY,
          options: {
            key: '{{secret:LAB_KEY}}',
            check: { state: 'ok', lines: [`signed in with ${SECRET_VALUE}`] },
          },
        },
      ],
      [{ name: 'farm', plugin: 'lab' }],
    )

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('pass')
    expect(row?.message).toContain('signed in with')
    expect(row?.message).not.toContain(SECRET_VALUE)
  })

  it('says a plugin that declares no check has no account check, and starts no process for it', async () => {
    const project = await newProject()
    installFirstParty(project, { methods: [] })
    const raw = config(
      [{ name: 'lab', package: FIRST_PARTY, options: { ledgerFile: project.ledger } }],
      [{ name: 'farm', plugin: 'lab' }],
    )

    const [row] = await rows(project, raw)

    expect(row).toMatchObject({ status: 'pass' })
    expect(row?.message).toMatch(/; no account check$/)
    expect(ledgerMethods(project)).toEqual([])
  })

  it('shows only the entry that a --remote plugin remote names', async () => {
    const project = await newProject()
    installFirstParty(project, { methods: [] })
    const raw = config(
      [
        { name: 'lab', package: FIRST_PARTY },
        { name: 'spare', package: FIRST_PARTY },
      ],
      [
        { name: 'farm', plugin: 'lab' },
        { name: 'other', plugin: 'spare' },
        { name: 'team', protocol: 'playwright', url: 'ws://127.0.0.1:9/pw' },
      ],
    )

    expect((await rows(project, raw, { only: 'farm' })).map((row) => row.name)).toEqual([
      'Plugin lab',
    ])
    expect(await rows(project, raw, { only: 'team' })).toEqual([])
  })

  it('puts the plugin rows in the doctor --json document, and only the package that is not installed fails', async () => {
    const project = await newProject()
    installFirstParty(project)
    const raw = config(
      [
        { name: 'lab', package: FIRST_PARTY, options: { ledgerFile: project.ledger } },
        { name: 'gone', package: '@vostride/agent-qa-plugin-absent' },
      ],
      [
        { name: 'farm', plugin: 'lab' },
        { name: 'other', plugin: 'gone' },
      ],
    )

    const result = await runDoctorJson(project, raw)

    const pluginRows = result.rows.filter((row) => row.name.startsWith('Plugin '))
    expect(pluginRows.map((row) => [row.name, row.status])).toEqual([
      ['Plugin lab', 'pass'],
      ['Plugin gone', 'fail'],
    ])
    expect(pluginRows[0]?.message).toContain(`${FIRST_PARTY}, first-party, version`)
    expect(pluginRows[0]).not.toHaveProperty('fix')
    expect(pluginRows[1]?.fix).toBe('Run `npx agent-qa init --setup deps`.')
    expect(result.ok).toBe(false)
    expect(result.format).toBe(1)
    expect(result).not.toHaveProperty('checks')
    expect(result.rows.some((row) => row.name === 'Node.js')).toBe(true)
    expect(ledgerMethods(project)).toEqual(['initialize', 'check', 'shutdown'])
  })

  function stderrProject(project: Project): Record<string, unknown> {
    installFirstParty(project)
    return config(
      [
        {
          name: 'lab',
          package: FIRST_PARTY,
          options: {
            key: '{{secret:LAB_KEY}}',
            stderr: { check: 'checking the plan with ' + SECRET_VALUE },
          },
        },
      ],
      [{ name: 'farm', plugin: 'lab' }],
    )
  }

  function captureStderr(): string[] {
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(plain(String(chunk)))
      return true
    })
    consoleSpies.push(spy)
    return written
  }

  it("shows the account check's plugin stderr, masked and under its entry, as DEBUG lines on stderr under --log-level debug, and its JSON stays whole", async () => {
    const project = await newProject('LAB_KEY=' + SECRET_VALUE + '\n')
    const raw = stderrProject(project)
    const written = captureStderr()

    const result = await runDoctorJson(project, raw, '--log-level', 'debug')

    const row = result.rows.find((check) => check.name === 'Plugin lab')
    expect(row?.status).toBe('pass')
    const stderr = written.join('')
    expect(stderr).toMatch(
      /DEBUG\s+\[adapter\] plugin lab: checking the plan with \[secret:LAB_KEY\]/,
    )
    expect(stderr).not.toContain(SECRET_VALUE)
  })

  it('shows no plugin stderr at the default level', async () => {
    const project = await newProject('LAB_KEY=' + SECRET_VALUE + '\n')
    const raw = stderrProject(project)
    const written = captureStderr()

    await runDoctorJson(project, raw)

    expect(written.join('')).not.toContain('checking the plan')
  })
})


describe("doctor's plugin rows for setup problems", () => {
  beforeAll(() => {
    pinned = pinProcessTmpdir()
  })

  afterAll(() => {
    pinned.restore()
    removeTempRoots([pinned.root])
  })

  beforeEach(() => {
    printed = []
    consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
        printed.push(parts.map(String).join(' '))
      }),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
  })

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore()
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it('fails a first-party plugin that is not installed, with the deps fix', async () => {
    const project = await newProject()
    const raw = config([{ name: 'lab', package: FIRST_PARTY }], [{ name: 'farm', plugin: 'lab' }])

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('fail')
    expect(row?.message).toContain('declared, not installed')
    expect(row?.fix).toBe('Run `npx agent-qa init --setup deps`.')
  })

  it('keeps the other problems of a plugin that is not installed in its row', async () => {
    const project = await newProject()
    const raw = config(
      [{ name: 'lab', package: FIRST_PARTY, options: { key: '{{secret:LAB_KEY}}' } }],
      [{ name: 'farm', plugin: 'lab' }],
    )

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('fail')
    expect(row?.message).toContain('declared, not installed')
    expect(row?.message).toContain('LAB_KEY')
  })

  it('compares a first-party plugin with the version of the agent-qa it is given', async () => {
    const project = await newProject()
    installFirstParty(project, { version: '0.0.1' })
    const raw = config([{ name: 'lab', package: FIRST_PARTY }], [{ name: 'farm', plugin: 'lab' }])

    const [row] = await rows(project, raw, { agentQaVersion: '0.0.1' })

    expect(row?.message).toContain('version 0.0.1')
    expect(row?.message).not.toContain('plugins add')
  })

  it("compares a first-party plugin with the project's installed agent-qa, not the running one", async () => {
    const project = await newProject()
    installFirstParty(project, { version: '0.0.1' })
    writeInstalledPackage(project.dir, 'agent-qa', '0.0.1')
    const raw = config(
      [{ name: 'lab', package: FIRST_PARTY, options: { ledgerFile: project.ledger } }],
      [{ name: 'farm', plugin: 'lab' }],
    )

    const result = await runDoctorJson(project, raw)

    const row = result.rows.find((entry) => entry.name === 'Plugin lab')
    expect(row?.status).toBe('pass')
    expect(row?.message).toContain(`${FIRST_PARTY}, first-party, version 0.0.1`)
  })

  it('tells a first-party plugin at another version to run plugins add', async () => {
    const project = await newProject()
    installFirstParty(project, { version: '0.0.1' })
    const raw = config([{ name: 'lab', package: FIRST_PARTY }], [{ name: 'farm', plugin: 'lab' }])

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('version 0.0.1')
    expect(row?.message).toContain(
      `Run npx agent-qa plugins add ${FIRST_PARTY}.`,
    )
  })

  it('fails a third-party package that is not installed with its plugins add line, with no version', async () => {
    const project = await newProject()
    const raw = config(
      [{ name: 'grid', package: '@acme/agent-qa-plugin-grid' }],
      [{ name: 'farm', plugin: 'grid' }],
    )

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('fail')
    expect(row?.message).toContain('third-party')
    expect(row?.message).toContain('declared, not installed')
    expect(row?.fix).toBe('Run `npx agent-qa plugins add @acme/agent-qa-plugin-grid`.')
  })

  it('names the path of a path plugin that is missing', async () => {
    const project = await newProject()
    const raw = config([{ name: 'lab', path: './plugins/lab' }], [{ name: 'farm', plugin: 'lab' }])

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('names the path ./plugins/lab, which has no package.json')
    expect(row?.message).not.toContain('plugins add')
  })

  it('warns about secrets its options and its remotes\' settings name that the secrets file does not declare, and runs no check', async () => {
    const project = await newProject('OTHER_KEY=other-secret-5d1e\n')
    installFirstParty(project)
    const raw = config(
      [
        {
          name: 'lab',
          package: FIRST_PARTY,
          options: { ledgerFile: project.ledger, key: '{{secret:LAB_KEY}}' },
        },
      ],
      [{ name: 'farm', plugin: 'lab', settings: { token: '{{secret:FARM_TOKEN}}' } }],
    )

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('warn')
    expect(row?.message).toContain(
      'Plugin entry lab: LAB_KEY, FARM_TOKEN not declared in .env.secrets.local.',
    )
    expect(ledgerMethods(project)).toEqual([])
  })

  it('says the secrets cannot be checked when workspace.secretsFile is not set', async () => {
    const project = await newProject()
    installFirstParty(project)
    const raw = config(
      [{ name: 'lab', package: FIRST_PARTY, options: { key: '{{secret:LAB_KEY}}' } }],
      [{ name: 'farm', plugin: 'lab' }],
    )

    const found = await createPluginChecks({ config: raw, configDir: project.dir })[0]?.check()

    expect(found?.status).toBe('warn')
    expect(found?.message).toContain(
      'Plugin entry lab: LAB_KEY cannot be checked; workspace.secretsFile is not set.',
    )
  })

  it('flags an entry no remote uses, and starts no process for it', async () => {
    const project = await newProject()
    installFirstParty(project)
    const raw = config(
      [{ name: 'lab', package: FIRST_PARTY, options: { ledgerFile: project.ledger } }],
      [],
    )

    const [row] = await rows(project, raw)

    expect(row?.status).toBe('warn')
    expect(row?.message).toContain(`${FIRST_PARTY}, first-party, version`)
    expect(row?.message).toContain('used by no remote')
    expect(ledgerMethods(project)).toEqual([])
  })

  it("makes no request of its own for provenance: the vendor sees only the plugin's check", async () => {
    const vendor = await startLoopbackFake({
      routes: { 'GET /v1/plan': [{ status: 200, json: { line: '3 parallel sessions' } }] },
    })
    try {
      const project = await newProject()
      writeVendorPlugin(join(project.dir, 'node_modules', '@acme', 'agent-qa-plugin-vendor'))
      const raw = config(
        [
          {
            name: 'vendor',
            package: '@acme/agent-qa-plugin-vendor',
            options: { vendor: vendor.url },
          },
        ],
        [{ name: 'farm', plugin: 'vendor' }],
      )
      const fetches = vi.spyOn(globalThis, 'fetch')

      const [row] = await rows(project, raw)

      expect(row).toMatchObject({ status: 'pass' })
      expect(row?.message).toContain('@acme/agent-qa-plugin-vendor, third-party, version 1.0.0')
      expect(row?.message).toMatch(/; 3 parallel sessions$/)
      expect(vendor.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        'GET /v1/plan',
      ])
      expect(fetches).not.toHaveBeenCalled()
    } finally {
      await vendor.close()
    }
  })

  it('still skips the local Appium, driver, Android SDK and Xcode rows when the only device is on a plugin remote', async () => {
    const project = await newProject()
    installFirstParty(project, { methods: [] })
    const raw = config(
      [{ name: 'lab', package: FIRST_PARTY }],
      [{ name: 'farm', plugin: 'lab' }],
      {
        targets: { app: { platform: 'android', appPackage: 'com.example', appActivity: '.Main' } },
        devices: { pixel: { platform: 'android', remote: 'farm' } },
      },
    )

    const result = await runDoctorJson(project, raw)

    const status = (name: string) => result.rows.find((row) => row.name === name)?.status
    expect(['Appium', 'Appium drivers', 'Android SDK', 'Xcode'].map(status)).toEqual([
      'skip',
      'skip',
      'skip',
      'skip',
    ])
    expect(result.rows.filter((row) => row.name.startsWith('Plugin ')).map((row) => row.status))
      .toEqual(['pass'])
  })
})
