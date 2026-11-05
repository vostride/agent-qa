import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Command } from 'commander'
import { stringify } from 'yaml'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { writeScriptedPlugin, type ScriptedPluginInput } from '@vostride/agent-qa-plugin-kit/testing'

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

async function rows(project: Project, raw: Record<string, unknown>, extra: Partial<PluginChecksInput> = {}): Promise<Row[]> {
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

async function runDoctorJson(project: Project, raw: Record<string, unknown>, ...args: string[]) {
  await writeFile(project.configPath, stringify(raw))
  printed = []
  process.exitCode = 0
  const program = new Command()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(createDoctorCommand())
  await program.parseAsync([
    'node',
    'agent-qa',
    '--config',
    project.configPath,
    'doctor',
    '--json',
    ...args,
  ])
  return JSON.parse(printed.join('\n')) as { ok: boolean; checks: Row[] }
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
    const raw = config([{ name: 'facts', path: './plugins/facts' }], [{ name: 'farm', plugin: 'facts' }])

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
          options: { script: { check: { error: { kind: 'auth', message: 'the lab key was rejected' } } } },
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

  it('puts the plugin rows in the doctor --json result, and none of them fails', async () => {
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

    const pluginRows = result.checks.filter((row) => row.name.startsWith('Plugin '))
    expect(pluginRows.map((row) => [row.name, row.status])).toEqual([
      ['Plugin lab', 'pass'],
      ['Plugin gone', 'warn'],
    ])
    expect(pluginRows[0]?.message).toContain(`${FIRST_PARTY}, first-party, version`)
    expect(result.checks.some((row) => row.name === 'Node.js')).toBe(true)
    expect(ledgerMethods(project)).toEqual(['initialize', 'check', 'shutdown'])
  })
})
