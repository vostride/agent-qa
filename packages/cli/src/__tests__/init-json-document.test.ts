import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getAgentQaVersion, getAuthPath } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import type { InitDocument } from '../commands/init-document.js'
import { initNextSteps } from '../commands/init-next-steps.js'
import { defaultProjectIo, type ProjectIo, type RunResult } from '../commands/project-host.js'
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
  hooks: { composeAnalytics?: typeof composeAnalyticsHost; io?: ProjectIo } = {},
): Promise<InitExit> {
  stdout.mockClear()
  stderr.mockClear()
  const program = new Command('agent-qa')
    .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
    .addCommand(
      createInitCommand({
        cwd,
        host: {
          homedir: home,
          env: {},
          run,
          argv: ['init', ...args],
          execPath: NODE,
          ...(hooks.io === undefined ? {} : { io: hooks.io }),
        },
        isTTY: false,
        composeAnalytics: hooks.composeAnalytics ?? silentAnalytics,
        chromium: () => ({ found: true, path: '/fake/chromium' }),
        latestVersion: async () => ({ source: 'none' }),
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
      { name: 'dashboard', outcome: 'skipped', reason: 'not interactive' },
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
      'dashboard',
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

  it('agentQa names the running version when package.json declares a newer one under --pm none', async () => {
    const { root, home } = tempProject('json-declared-newer')
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ devDependencies: { 'agent-qa': '99.0.0' } })}\n`,
    )

    const result = await init(root, home, ['--json', '--platform', 'web', '--pm', 'none'])

    expect(documentOf(result).agentQa).toEqual({ version: VERSION, via: 'running' })
  })

  it("agentQa names the version of the project's older copy that ran validate", async () => {
    const { root, home } = tempProject('json-older-copy')
    writeInstalledPackage(root, 'agent-qa', '0.0.1', {
      packageJson: { bin: { 'agent-qa': 'cli.js' } },
      files: { 'cli.js': '' },
    })
    const run = probeOr(() => OK)

    const result = await init(
      root,
      home,
      ['--json', '--platform', 'web', '--llm', 'gemini', '--pm', 'npm', '--agents', 'none'],
      run,
    )

    expect(documentOf(result).agentQa).toEqual({ version: '0.0.1', via: 'project' })
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
      { name: 'dashboard', outcome: 'skipped', reason: 'not interactive' },
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

  it('a refusal inside a step is a refused document that lists every planned step', async () => {
    const { root, home } = tempProject('json-refused-in-a-step')
    writeFileSync(join(root, '.gitignore'), '# agent-qa init:start\nnode_modules/\n')

    const result = await init(root, home, ['--json', '--platform', 'web', '--pm', 'none'])

    const doc = documentOf(result)
    expect(result.exit).toBe(2)
    expect(doc).toMatchObject({ outcome: 'refused', exitCode: 2 })
    expect(doc.steps).toEqual([
      { name: 'package-json', outcome: 'failed', reason: expect.any(String) },
      { name: 'scaffold', outcome: 'skipped', reason: 'not run' },
      { name: 'install', outcome: 'skipped', reason: 'not run' },
      { name: 'chromium', outcome: 'skipped', reason: 'not run' },
      { name: 'skills', outcome: 'skipped', reason: 'not run' },
      { name: 'validate', outcome: 'skipped', reason: 'not run' },
      { name: 'dashboard', outcome: 'skipped', reason: 'not run' },
    ])
  })

  it('an error between steps is a failed document that lists every planned step', async () => {
    const { root, home } = tempProject('json-error-between-steps')
    const broken: typeof composeAnalyticsHost = async () => {
      throw new Error('the analytics host is gone')
    }

    const result = await init(
      root,
      home,
      ['--json', '--platform', 'web', '--pm', 'none'],
      fakeRunner(),
      { composeAnalytics: broken },
    )

    const doc = documentOf(result)
    expect(result.exit).toBe(1)
    expect(doc).toMatchObject({
      outcome: 'failed',
      exitCode: 1,
      message: 'the analytics host is gone',
    })
    expect(doc.steps).toEqual([
      { name: 'package-json', outcome: 'done' },
      { name: 'scaffold', outcome: 'done' },
      { name: 'install', outcome: 'skipped', reason: 'not run' },
      { name: 'chromium', outcome: 'skipped', reason: 'not run' },
      { name: 'skills', outcome: 'skipped', reason: 'not run' },
      { name: 'validate', outcome: 'skipped', reason: 'not run' },
      { name: 'dashboard', outcome: 'skipped', reason: 'not run' },
    ])
  })

  it('an unsafe agent-qa-knowledge/.gitignore is a refused document through the one handler', async () => {
    const { root, home } = tempProject('json-knowledge-gitignore')
    rmSync(join(root, '.git'), { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' })
    mkdirSync(join(root, 'agent-qa-knowledge'))
    writeFileSync(join(root, 'agent-qa-knowledge', '.gitignore'), '# mine\n')

    const result = await init(root, home, ['--json', '--platform', 'web', '--pm', 'none'])

    const doc = documentOf(result)
    expect(result.exit).toBe(2)
    expect(doc).toMatchObject({ outcome: 'refused', exitCode: 2, steps: [], files: [] })
    expect(doc.message).toMatch(/^existing agent-qa-knowledge\/\.gitignore is unsafe: /u)
    expect(result.stderr).toContain(doc.message)
  })

  it('a bad option value before --json is a refused document', async () => {
    const { root, home } = tempProject('json-bad-value-first')

    for (const args of [
      ['--pm', 'gpt', '--json'],
      ['--json', '--pm', 'gpt'],
    ]) {
      const result = await init(root, home, args)

      const doc = documentOf(result)
      expect(result.exit, args.join(' ')).toBe(2)
      expect(doc, args.join(' ')).toMatchObject({ outcome: 'refused', exitCode: 2, steps: [] })
      expect(doc.message, args.join(' ')).toContain('Allowed choices are')
    }
  })

  it('a --json after -- is an argument and asks for no document', async () => {
    const { root, home } = tempProject('json-after-dashes')

    const result = await init(root, home, ['--pm', 'gpt', '--', '--json'])

    expect(result.exit).toBe(2)
    expect(result.stdout).toBe('')
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
      { name: 'dashboard', outcome: 'skipped', reason: 'interrupted' },
    ])
    expect(result.stderr).toContain('Cancelled.\n')
  })

  it('a Ctrl-C between steps is an interrupted document with exit code 130', async () => {
    const { root, home } = tempProject('json-interrupted-between-steps')
    writeInstalledPackage(root, 'agent-qa', VERSION, {
      packageJson: { bin: { 'agent-qa': 'cli.js' } },
      files: { 'cli.js': '' },
    })
    const before = process.listeners('SIGINT')
    let validated = false
    const run = probeOr((args) => {
      if (args.includes('validate')) validated = true
      return OK
    })
    // Read after validate, outside any step.
    const io: ProjectIo = {
      ...defaultProjectIo,
      exists: (path) => {
        if (validated && path.includes('agent-qa-subscription-auth')) {
          validated = false
          for (const listener of process.listeners('SIGINT')) {
            if (!before.includes(listener)) (listener as () => void)()
          }
        }
        return defaultProjectIo.exists(path)
      },
    }

    const result = await init(
      root,
      home,
      ['--json', '--platform', 'web', '--llm', 'gemini', '--no-browsers', '--agents', 'none'],
      run,
      { io },
    )

    const doc = documentOf(result)
    expect(result.exit).toBe(130)
    expect(doc).toMatchObject({ outcome: 'interrupted', exitCode: 130, message: 'Cancelled.' })
    expect(doc.steps.map((step) => [step.name, step.outcome, step.reason])).toEqual([
      ['package-json', 'done', undefined],
      ['scaffold', 'done', undefined],
      ['install', 'done', undefined],
      ['chromium', 'skipped', '--no-browsers'],
      ['skills', 'skipped', 'none chosen'],
      ['validate', 'done', undefined],
      ['dashboard', 'skipped', 'interrupted'],
    ])
    expect(result.stderr).toContain('Cancelled.\n')
    expect(process.listeners('SIGINT')).toEqual(before)
  })

  it('a re-run of an initialized project skips its current rows, validates and writes no file', async () => {
    const { root, home } = tempProject('json-initialized')
    await init(root, home, ['--platform', 'web', '--pm', 'none'])
    const declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    for (const [name, version] of Object.entries(declared.devDependencies)) {
      writeInstalledPackage(root, name, version)
    }

    const result = await init(root, home, ['--json', '--pm', 'none'])

    const doc = documentOf(result)
    expect(result.exit).toBeUndefined()
    expect(doc).toMatchObject({ outcome: 'done', exitCode: 0, files: [] })
    expect(doc.steps).toEqual([
      { name: 'deps', outcome: 'skipped', reason: 'current' },
      { name: 'skills', outcome: 'skipped', reason: 'current' },
      { name: 'mcp', outcome: 'skipped', reason: 'current' },
      { name: 'agents-md', outcome: 'skipped', reason: 'current' },
      { name: 'browsers', outcome: 'skipped', reason: 'current' },
      { name: 'gitignore', outcome: 'skipped', reason: 'current' },
      { name: 'scaffold', outcome: 'skipped', reason: 'current' },
      { name: 'validate', outcome: 'done' },
    ])
    expect(doc.agentQa).toEqual({ version: VERSION, via: 'running' })
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
