// plugins add: declare, install and enable, on temporary projects with a fake runner.
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion, PluginEntrySchema } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { parse } from 'yaml'

import { createPluginsCommand } from '../commands/plugins.js'
import type { RunOptions, RunResult } from '../commands/project-host.js'
import { CliRefusal } from '../composition/cli-refusal.js'
import { resolveConfig } from '../config.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
  type RunnerCall,
} from './project-fixtures.js'

const VERSION = getAgentQaVersion().trim()
const KERNEL = '@vostride/agent-qa-plugin-kernel'
const SUBSCRIPTION = '@vostride/agent-qa-subscription-auth'

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

let log: MockInstance<typeof console.log>

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempProjects()
})

type Call = { command: string; args: readonly string[]; options: RunOptions }

function isProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

function isLookup(args: readonly string[]): boolean {
  return args.includes('--json')
}

function declaredDependencies(folder: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf-8')) as {
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }
  return { ...manifest.dependencies, ...manifest.devDependencies }
}

function installsDeclared({ options }: Call): RunResult {
  for (const [name, version] of Object.entries(declaredDependencies(options.cwd))) {
    writeInstalledPackage(options.cwd, name, version)
  }
  return { code: 0, signal: null, output: '' }
}

function machine(
  install: (call: Call) => RunResult = installsDeclared,
  lookup: (call: Call) => RunResult = () => ({ code: 1, signal: null, output: 'no lookup' }),
): FakeRunner {
  return fakeRunner((call) => {
    if (isProbe(call.args)) return { code: 0, signal: null, output: '11.0.0\n' }
    if (isLookup(call.args)) return lookup(call)
    return install(call)
  })
}

function installs(run: FakeRunner): RunnerCall[] {
  return run.calls.filter((call) => !isProbe(call.args) && !isLookup(call.args))
}

function writeConfig(root: string, lines: readonly string[]): string {
  const text = ['# the project settings agent-qa reads', ...WORKSPACE, ...lines, ''].join('\n')
  writeFileSync(join(root, 'agent-qa.config.yaml'), text)
  return text
}

function project(lines: readonly string[] = ['plugins: []']) {
  const { root, home } = tempProject('plugins-add')
  writeConfig(root, lines)
  return { root, home }
}

async function add(
  folders: { root: string; home: string },
  run: FakeRunner,
  args: readonly string[],
  config = join(folders.root, 'agent-qa.config.yaml'),
): Promise<void> {
  const program = new Command()
  program.exitOverride()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(
    createPluginsCommand({ host: { cwd: folders.root, homedir: folders.home, env: {}, run } }),
  )
  await program.parseAsync(['node', 'agent-qa', '--config', config, 'plugins', 'add', ...args])
}

function stdout(): string {
  return stripVTControlCharacters(
    log.mock.calls.map((call) => call.map(String).join(' ')).join('\n'),
  )
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(root, path)] = readFileSync(path, 'utf-8')
    }
  }
  walk(root)
  return files
}

async function refusal(promise: Promise<void>): Promise<CliRefusal> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(CliRefusal)
  return error as CliRefusal
}

function configOf(root: string): string {
  return readFileSync(join(root, 'agent-qa.config.yaml'), 'utf-8')
}

describe('plugins add with a first-party plugin', () => {
  it('declares it at the running version, installs it once and writes the entry under the comment', async () => {
    const folders = project()
    const run = machine()

    await add(folders, run, [KERNEL, '--pm', 'npm'])

    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: VERSION })
    expect(installs(run).map((call) => [call.command, ...call.args, call.cwd])).toEqual([
      ['npm', 'install', realpathSync(folders.root)],
    ])
    const config = configOf(folders.root)
    expect(config).toContain('# the project settings agent-qa reads')
    expect(config).toContain(`  - name: kernel\n    package: "${KERNEL}"\n`)
    expect(stdout()).toContain(`✓ Added the plugins entry kernel for ${KERNEL} ${VERSION}.`)
    expect(stdout()).toContain('Next: npx agent-qa plugins describe kernel')
  })

  it('creates plugins when the config has none, and the result is a valid config', async () => {
    const folders = project([])

    await add(folders, machine(), [KERNEL, '--pm', 'npm'])

    const plugins = (parse(configOf(folders.root)) as { plugins: unknown[] }).plugins
    expect(plugins).toEqual([{ name: 'kernel', package: KERNEL }])
    expect(PluginEntrySchema.safeParse(plugins[0]).success).toBe(true)
    const config = await resolveConfig({
      configPath: join(folders.root, 'agent-qa.config.yaml'),
      loadAuthPlugins: false,
    })
    expect(config.plugins).toEqual([{ name: 'kernel', package: KERNEL }])
  })

  it('names the subscription package subscription', async () => {
    const folders = project()

    await add(folders, machine(), [SUBSCRIPTION, '--pm', 'npm'])

    expect(declaredDependencies(folders.root)).toEqual({ [SUBSCRIPTION]: VERSION })
    expect(configOf(folders.root)).toContain(
      `  - name: subscription\n    package: "${SUBSCRIPTION}"\n`,
    )
    expect(stdout()).toContain('Next: npx agent-qa plugins describe subscription')
  })

  it('keeps an entry that already declares the package', async () => {
    const folders = project(['plugins:', '  - name: k', `    package: "${KERNEL}"`])
    const before = configOf(folders.root)

    await add(folders, machine(), [KERNEL, '--pm', 'npm'])

    expect(configOf(folders.root)).toBe(before)
    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: VERSION })
  })
})

describe('plugins add refusals', () => {
  it.each([
    ['./plugins/x', 'agent-qa plugins add takes an npm package name. Add a path plugin by hand'],
    ['/abs/plugin', 'agent-qa plugins add takes an npm package name.'],
    ['~/plugin', 'agent-qa plugins add takes an npm package name.'],
    ['C:\\plugins\\x', 'agent-qa plugins add takes an npm package name.'],
    ['Not_A_Name!', 'Not_A_Name! is not an npm package name.'],
    [
      `${KERNEL}@0.0.1`,
      `${KERNEL} runs only at agent-qa's version, ${VERSION}. Run npx agent-qa plugins add ${KERNEL}.`,
    ],
  ])('%s exits 2, changes no file and runs nothing', async (argument, line) => {
    const folders = project()
    const before = snapshot(folders.root)
    const run = machine()

    const error = await refusal(add(folders, run, [argument, '--pm', 'npm']))

    expect(error.exitCode).toBe(2)
    expect(error.message).toContain(line)
    expect(snapshot(folders.root)).toEqual(before)
    expect(run.calls).toEqual([])
  })

  it('the path refusal says how to add a path plugin by hand', async () => {
    const error = await refusal(add(project(), machine(), ['./plugins/x']))
    expect(error.message).toBe(
      'agent-qa plugins add takes an npm package name. Add a path plugin by hand: under plugins in agent-qa.config.yaml, write - name: <name> with path: <folder>.',
    )
  })

  it('a missing config exits 2 and changes nothing', async () => {
    const { root, home } = tempProject('plugins-add')
    const missing = join(root, 'missing.config.yaml')
    const run = machine()

    const error = await refusal(add({ root, home }, run, [KERNEL], missing))

    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(
      `No agent-qa config at ${missing}. Run npx agent-qa init in the project's folder first.`,
    )
    expect(existsSync(join(root, 'package.json'))).toBe(false)
    expect(run.calls).toEqual([])
  })

  it('a failed install exits 3, keeps the declaration and leaves the config as it was', async () => {
    const folders = project()
    const before = configOf(folders.root)
    const run = machine(() => ({ code: 1, signal: null, output: 'npm error 404' }))

    const error = await refusal(add(folders, run, [KERNEL, '--pm', 'npm']))

    expect(error.exitCode).toBe(3)
    expect(error.lines).toEqual([])
    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: VERSION })
    expect(configOf(folders.root)).toBe(before)
  })

  it('--pm none is not a choice and exits 2', async () => {
    const folders = project()
    const run = machine()

    const error = await refusal(add(folders, run, [KERNEL, '--pm', 'none']))

    expect(error.exitCode).toBe(2)
    expect(run.calls).toEqual([])
  })
})
