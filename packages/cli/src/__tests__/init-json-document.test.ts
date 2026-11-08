import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getAgentQaVersion, getAuthPath } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import type { InitDocument } from '../commands/init-document.js'
import { initNextSteps } from '../commands/init-next-steps.js'
import type { RunResult } from '../commands/project-host.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import {
  cleanupTempProjects,
  fakeRunner,
  skillFolderFiles,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
} from './project-fixtures.js'

const VERSION = getAgentQaVersion().trim()
const NODE = '/fake/node'
const OK: RunResult = { code: 0, signal: null, output: '' }

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-json', runtimeContext: 'user' }),
  })

let stdout: MockInstance<typeof process.stdout.write>
let stderr: MockInstance<typeof process.stderr.write>

function written(spy: MockInstance<(chunk: never) => boolean>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

interface InitExit {
  stdout: string
  stderr: string
  exit: number | undefined
}

async function init(
  cwd: string,
  home: string,
  args: readonly string[],
  run: FakeRunner = fakeRunner(),
): Promise<InitExit> {
  stdout.mockClear()
  stderr.mockClear()
  const program = new Command('agent-qa')
    .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
    .addCommand(
      createInitCommand({
        cwd,
        host: { homedir: home, env: {}, run, argv: ['init', ...args], execPath: NODE },
        isTTY: false,
        composeAnalytics: silentAnalytics,
      }),
    )
  const handler: string[] = []
  let exit: number | undefined
  const deps: CliFailureDeps = {
    print: (text) => handler.push(`${text}\n`),
    printFixed: (line) => handler.push(`${line}\n`),
    mask: (text) => text,
    setExitCode: () => {},
    flush: async () => {},
    exit: (code) => {
      exit = code
    },
    env: {},
  }
  await runCli(program, ['node', 'agent-qa', 'init', ...args], deps)
  return { stdout: written(stdout), stderr: written(stderr) + handler.join(''), exit }
}

function documentOf(result: InitExit): InitDocument {
  expect(result.stdout.endsWith('}\n')).toBe(true)
  return JSON.parse(result.stdout) as InitDocument
}

function probeOr(answer: (args: readonly string[]) => RunResult): FakeRunner {
  return fakeRunner(({ args }) =>
    args[0] === '--version' ? { code: 0, signal: null, output: '10.0.0\n' } : answer(args),
  )
}

beforeEach(() => {
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempProjects()
})

describe('init --json prints one document on stdout', () => {
  it('a fresh init is done with every step, the files it wrote and what it declared', async () => {
    const { root, home } = tempProject('json-done')

    const result = await init(root, home, ['--json', '--platform', 'web', '--pm', 'none'])

    const doc = documentOf(result)
    expect(result.exit).toBeUndefined()
    expect(Object.keys(doc)).toEqual([
      'format',
      'outcome',
      'exitCode',
      'steps',
      'files',
      'agents',
      'packageManager',
      'agentQa',
      'plugins',
      'model',
      'nextSteps',
    ])
    expect(doc).toMatchObject({ format: 1, outcome: 'done', exitCode: 0, packageManager: 'none' })
    expect(doc.steps).toEqual([
      { name: 'package-json', outcome: 'done' },
      { name: 'scaffold', outcome: 'done' },
      { name: 'install', outcome: 'skipped', reason: '--pm none', command: 'npm install' },
      { name: 'chromium', outcome: 'done' },
      { name: 'skills', outcome: 'done' },
      {
        name: 'validate',
        outcome: 'skipped',
        reason: 'install first (--pm none)',
        command: 'npx agent-qa validate',
      },
      {
        name: 'sign-in',
        outcome: 'skipped',
        reason: 'not interactive',
        command: 'npx agent-qa auth login --config claude-code',
      },
    ])
    expect(doc.files).toContainEqual({
      path: '.gitignore',
      outcome: 'created',
      step: 'package-json',
    })
    expect(doc.files).toContainEqual({
      path: 'package.json',
      outcome: 'created',
      step: 'package-json',
    })
    expect(doc.files).toContainEqual({
      path: 'tests/examples/komazon-checkout.yaml',
      outcome: 'created',
      step: 'scaffold',
    })
    expect(doc.files.filter((file) => file.step === 'scaffold').at(-1)).toEqual({
      path: 'agent-qa.config.yaml',
      outcome: 'created',
      step: 'scaffold',
    })
    expect(doc.files).toContainEqual({ path: 'AGENTS.md', outcome: 'created', step: 'skills' })
    expect(doc.files).toContainEqual({ path: '.mcp.json', outcome: 'created', step: 'skills' })
    expect(doc.agents).toEqual(['claude-code', 'codex'])
    expect(doc.agentQa).toEqual({ version: VERSION, via: 'running' })
    expect(doc.plugins).toEqual([
      { package: '@vostride/agent-qa-subscription-auth', version: VERSION },
    ])
    expect(doc.nextSteps).toEqual(
      initNextSteps({
        steps: doc.steps,
        model: {
          name: 'claude-code',
          provider: 'anthropic-subscription',
          status: 'pending',
          subscription: true,
          pluginInstalled: false,
        },
        web: true,
        mobile: false,
        agents: doc.agents,
        dashboard: { command: 'npx agent-qa dashboard' },
      }).steps,
    )
    expect(doc.nextSteps.map((step) => step.command)).toEqual([
      'npm install',
      'npx agent-qa validate',
      'npx agent-qa auth login --config claude-code',
      'npx agent-qa run suites/examples.suite.yaml',
      'npx agent-qa dashboard',
    ])
    expect(result.stderr).toContain('✓ package.json created')
    expect(result.stderr).toContain('– Declared agent-qa')
  })

  it('--no-browsers lists the Chromium step after the install, skipped with its command', async () => {
    const { root, home } = tempProject('json-no-browsers')
    const run = fakeRunner()

    const result = await init(
      root,
      home,
      ['--json', '--platform', 'web', '--pm', 'none', '--no-browsers'],
      run,
    )

    const doc = documentOf(result)
    expect(doc.steps.map((step) => step.name)).toEqual([
      'package-json',
      'scaffold',
      'install',
      'chromium',
      'skills',
      'validate',
      'sign-in',
    ])
    expect(doc.steps.find((step) => step.name === 'chromium')).toEqual({
      name: 'chromium',
      outcome: 'skipped',
      reason: '--no-browsers',
      command: 'npx agent-qa install-browsers --chromium',
    })
    expect(run.calls.filter((call) => call.args.includes('install-browsers'))).toEqual([])
  })

  it('the skills step lists its files, and agentQa.via names the copy that ran validate', async () => {
    const { root, home } = tempProject('json-skills')
    writeInstalledPackage(root, 'agent-qa', VERSION, {
      packageJson: { bin: { 'agent-qa': 'cli.js' } },
      files: { 'cli.js': '', ...skillFolderFiles('agent-qa-alpha') },
    })
    const run = probeOr(() => OK)

    const result = await init(
      root,
      home,
      ['--json', '--platform', 'web', '--llm', 'gemini', '--pm', 'npm', '--agents', 'claude-code'],
      run,
    )

    const doc = documentOf(result)
    expect(doc.files.filter((file) => file.step === 'skills')).toEqual([
      { path: '.claude/skills/agent-qa-alpha/SKILL.md', outcome: 'created', step: 'skills' },
      { path: '.mcp.json', outcome: 'created', step: 'skills' },
      { path: 'AGENTS.md', outcome: 'created', step: 'skills' },
    ])
    expect(doc.agentQa).toEqual({ version: VERSION, via: 'project' })
    expect(run.calls.map((call) => call.args.slice(1))).toContainEqual(['validate'])
  })

  it('a Gemini init with a saved Gemini key records the model as ready', async () => {
    const { root, home } = tempProject('json-model-ready')
    const authPath = getAuthPath({ env: {}, homeDir: home })
    mkdirSync(dirname(authPath), { recursive: true })
    writeFileSync(
      authPath,
      JSON.stringify({ gemini: { type: 'api', provider: 'gemini', key: 'DUMMY-KEY-C' } }),
    )

    const result = await init(root, home, [
      '--json',
      '--platform',
      'web',
      '--llm',
      'gemini',
      '--pm',
      'none',
      '--agents',
      'none',
    ])

    const doc = documentOf(result)
    const model = doc.model
    expect(`${model?.name} ${model?.provider} ${model?.status}`).toBe('gemini gemini ready')
    expect(model).toEqual({ name: 'gemini', provider: 'gemini', status: 'ready' })
    expect(result.stdout).not.toContain('DUMMY-KEY-C')
  })

  it('an OpenAI-compatible endpoint choice records the model as pending on the dashboard', async () => {
    const { root, home } = tempProject('json-model-pending')

    const result = await init(root, home, [
      '--json',
      '--platform',
      'web',
      '--llm',
      'openai-compatible',
      '--pm',
      'none',
      '--agents',
      'none',
    ])

    const doc = documentOf(result)
    expect(result.exit).toBeUndefined()
    expect(doc.exitCode).toBe(0)
    expect(doc.model).toMatchObject({
      status: 'pending',
      reason: "set up on the dashboard's model page",
    })
  })

  it('a failed install is a failed document with exit code 3 and the step command', async () => {
    const { root, home } = tempProject('json-failed')
    const run = probeOr(() => ({ code: 1, signal: null, output: 'npm ERR! boom\n' }))

    const result = await init(root, home, ['--json', '--platform', 'web', '--llm', 'gemini'], run)

    const doc = documentOf(result)
    expect(result.exit).toBe(3)
    expect(doc).toMatchObject({ outcome: 'failed', exitCode: 3, packageManager: 'npm' })
    expect(doc).not.toHaveProperty('message')
    expect(doc.steps).toEqual([
      { name: 'package-json', outcome: 'done' },
      { name: 'scaffold', outcome: 'done' },
      {
        name: 'install',
        outcome: 'failed',
        reason: 'Install failed: npm exited 1\n  npm ERR! boom',
        command: 'npm install',
      },
      {
        name: 'chromium',
        outcome: 'failed',
        reason: 'Chromium download failed twice: npm ERR! boom',
        command: 'npx agent-qa install-browsers --chromium',
      },
      { name: 'skills', outcome: 'done' },
      {
        name: 'validate',
        outcome: 'failed',
        reason: 'npm ERR! boom',
        command: 'npx agent-qa validate',
      },
      { name: 'sign-in', outcome: 'skipped', reason: 'not a subscription model' },
    ])
    expect(doc.plugins).toEqual([])
    expect(result.stderr).toContain('✗ Install failed: npm exited 1')
    expect(result.stderr).toContain('  Run: npm install')
  })

  it('the home folder is a refused document with exit code 2, its message and no steps', async () => {
    const { home } = tempProject('json-refused')
    const message = `agent-qa init does not set up your home folder (${home}). Run it in the project's folder.`

    const result = await init(home, home, ['--json', '--pm', 'none'])

    const doc = documentOf(result)
    expect(result.exit).toBe(2)
    expect(doc).toEqual({
      format: 1,
      outcome: 'refused',
      exitCode: 2,
      message,
      steps: [],
      files: [],
      agents: [],
      plugins: [],
      nextSteps: [],
    })
    expect(result.stderr).toContain(message)
  })

  it('a Ctrl-C during the install is an interrupted document with exit code 130', async () => {
    const { root, home } = tempProject('json-interrupted')
    const run = probeOr(() => ({ code: 130, signal: null, output: '' }))

    const result = await init(root, home, ['--json', '--platform', 'web', '--llm', 'gemini'], run)

    const doc = documentOf(result)
    expect(result.exit).toBe(130)
    expect(doc).toMatchObject({ outcome: 'interrupted', exitCode: 130, message: 'Cancelled.' })
    expect(doc.steps).toEqual([
      { name: 'package-json', outcome: 'done' },
      { name: 'scaffold', outcome: 'done' },
      { name: 'install', outcome: 'failed', reason: 'interrupted' },
      { name: 'chromium', outcome: 'skipped', reason: 'interrupted' },
      { name: 'skills', outcome: 'skipped', reason: 'interrupted' },
      { name: 'validate', outcome: 'skipped', reason: 'interrupted' },
      { name: 'sign-in', outcome: 'skipped', reason: 'interrupted' },
      { name: 'dashboard', outcome: 'skipped', reason: 'interrupted' },
    ])
    expect(result.stderr).toContain('Cancelled.\n')
  })

  it('an initialized project is done with every planned step skipped as already initialized', async () => {
    const { root, home } = tempProject('json-initialized')
    await init(root, home, ['--platform', 'web', '--pm', 'none'])

    const result = await init(root, home, ['--json', '--platform', 'web', '--pm', 'none'])

    const doc = documentOf(result)
    expect(result.exit).toBeUndefined()
    expect(doc).toMatchObject({ outcome: 'done', exitCode: 0, files: [] })
    expect(doc.steps).toEqual([
      { name: 'package-json', outcome: 'skipped', reason: 'already initialized' },
      { name: 'scaffold', outcome: 'skipped', reason: 'already initialized' },
      { name: 'install', outcome: 'skipped', reason: 'already initialized' },
      { name: 'chromium', outcome: 'skipped', reason: 'already initialized' },
      { name: 'skills', outcome: 'skipped', reason: 'already initialized' },
      { name: 'validate', outcome: 'skipped', reason: 'already initialized' },
      { name: 'sign-in', outcome: 'skipped', reason: 'already initialized' },
      { name: 'dashboard', outcome: 'skipped', reason: 'already initialized' },
    ])
    expect(result.stderr).toContain('Project is already initialized at')
  })

  it('--force on an initialized project runs the fresh path and keeps the secrets file', async () => {
    const { root, home } = tempProject('json-force')
    await init(root, home, ['--platform', 'web', '--pm', 'none'])
    const secrets = join(root, '.env.secrets.local')
    writeFileSync(secrets, 'KOMAZON_PASSWORD=mine\n')

    const result = await init(root, home, [
      '--json',
      '--force',
      '--platform',
      'web',
      '--pm',
      'none',
    ])

    const doc = documentOf(result)
    expect(doc).toMatchObject({ outcome: 'done', exitCode: 0 })
    expect(doc.steps.map((step) => step.outcome)).toEqual([
      'done',
      'done',
      'skipped',
      'done',
      'done',
      'skipped',
      'skipped',
    ])
    expect(doc.files).toContainEqual({
      path: '.env.secrets.local',
      outcome: 'kept',
      step: 'scaffold',
    })
    expect(doc.files).toContainEqual({
      path: 'agent-qa.config.yaml',
      outcome: 'updated',
      step: 'scaffold',
    })
    expect(readFileSync(secrets, 'utf8')).toBe('KOMAZON_PASSWORD=mine\n')
  })

  it('a hand-off to a newer project agent-qa leaves the document to it', async () => {
    const { root, home } = tempProject('json-hand-off')
    writeInstalledPackage(root, 'agent-qa', '99.0.0', {
      packageJson: { bin: { 'agent-qa': 'cli.js' } },
      files: { 'cli.js': '' },
    })
    const run = fakeRunner(({ command }) => {
      if (command !== NODE) throw new Error(`unexpected command ${command}`)
      return OK
    })

    const result = await init(root, home, ['--json', '--platform', 'web'], run)

    expect(run.calls.map((call) => call.command)).toEqual([NODE])
    expect(result.exit).toBeUndefined()
    expect(result.stdout).toBe('')
  })

  it('a hand-off that the person stops leaves the document to the project agent-qa', async () => {
    const { root, home } = tempProject('json-hand-off-stopped')
    writeInstalledPackage(root, 'agent-qa', '99.0.0', {
      packageJson: { bin: { 'agent-qa': 'cli.js' } },
      files: { 'cli.js': '' },
    })
    const run = fakeRunner(() => ({ code: 130, signal: null, output: '' }))

    const result = await init(root, home, ['--json', '--platform', 'web'], run)

    expect(result.exit).toBe(130)
    expect(result.stdout).toBe('')
  })
})
