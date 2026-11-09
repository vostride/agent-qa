// A newer agent-qa that package.json declares is installed first and then takes over init.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { reportCliFailure } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import type { RunOptions, RunResult } from '../commands/project-host.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { CliRefusal } from '../composition/cli-refusal.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
  type RunnerCall,
} from './project-fixtures.js'

const VERSION = getAgentQaVersion().trim()
const NODE = '/fake/node'
const INIT_ARGS = ['--platform', 'web', '--llm', 'gemini', '--no-browsers', '--agents', 'none']
let log: MockInstance<typeof console.log>
let errors: MockInstance<typeof process.stderr.write>

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-hand-off', runtimeContext: 'user' }),
  })

type Answer = (call: { command: string; args: readonly string[]; options: RunOptions }) => RunResult

const OK: RunResult = { code: 0, signal: null, output: '' }

function isProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

function machine(install: Answer, handOff: Answer = () => OK): FakeRunner {
  return fakeRunner((call) => {
    if (isProbe(call.args)) return { code: 0, signal: null, output: '11.0.0\n' }
    if (call.command === NODE) return handOff(call)
    return install(call)
  })
}

function writeCopy(dir: string, version: string): void {
  writeInstalledPackage(dir, 'agent-qa', version, {
    packageJson: { bin: { 'agent-qa': 'cli.js' } },
    files: { 'cli.js': '' },
  })
}

function installsCopy(version: string): Answer {
  return ({ options }) => {
    writeCopy(options.cwd, version)
    return OK
  }
}

// init's validate step runs through agent-qa after the install; these cells are about the
// install and the hand-off.
function managerAndHandOffCalls(run: FakeRunner): RunnerCall[] {
  return run.calls.filter((call) => !call.args.includes('validate'))
}

function commands(run: FakeRunner): RunnerCall[] {
  return managerAndHandOffCalls(run).filter((call) => !isProbe(call.args))
}

function argv(call: RunnerCall): string {
  return [call.command, ...call.args].join(' ')
}

function initArgv(args: readonly string[]): string[] {
  return ['init', ...args]
}

// The cells are about the hand-off and the install, so no Chromium or coding-agent step runs.
function aboutTheInstall(args: readonly string[]): string[] {
  const browsers = args.includes('--no-browsers') ? [] : ['--no-browsers']
  const agents = args.includes('--agents') ? [] : ['--agents', 'none']
  return [...args, ...browsers, ...agents]
}

async function init(
  cwd: string,
  home: string,
  run: FakeRunner,
  given: readonly string[] = INIT_ARGS,
): Promise<void> {
  const args = aboutTheInstall(given)
  const parent = new Command()
  const command = createInitCommand({
    cwd,
    host: { homedir: home, env: {}, run, argv: initArgv(args), execPath: NODE },
    isTTY: false,
    composeAnalytics: silentAnalytics,
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  await parent.parseAsync(['node', 'test', 'init', ...args])
}

async function refusal(run: Promise<void>): Promise<CliRefusal> {
  const error = await run.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(CliRefusal)
  return error as CliRefusal
}

function failureDeps() {
  return {
    print: () => {},
    printFixed: () => {},
    mask: (text: string) => text,
    setExitCode: () => {},
    flush: async () => {},
    exit: () => {},
    env: {},
  }
}

// init draws its human output on stderr.
function stderr(): string {
  return stripVTControlCharacters(errors.mock.calls.map((call) => String(call[0])).join(''))
}

function declare(root: string, spec: string): void {
  const manifest = { name: 'app', private: true, devDependencies: { 'agent-qa': spec } }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function configured(root: string): boolean {
  return existsSync(join(root, 'agent-qa.config.yaml'))
}

function devDependencies(root: string): unknown {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    devDependencies?: unknown
  }
  return pkg.devDependencies
}

describe('init installs a declared newer agent-qa, then hands off to it', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('a declared newer agent-qa that is not installed is installed, then runs init', async () => {
    const { root, home } = tempProject('hand-off-declared')
    declare(root, '99.0.0')
    const run = machine(installsCopy('99.0.0'))

    await expect(init(root, home, run)).resolves.toBeUndefined()

    const real = realpathSync(root)
    const [install, handOff, ...rest] = commands(run)
    expect(rest).toEqual([])
    expect(install).toMatchObject({
      command: 'npm',
      args: ['install'],
      cwd: real,
      stdio: 'capture',
    })
    expect(handOff).toMatchObject({
      command: NODE,
      args: [join(real, 'node_modules', 'agent-qa', 'cli.js'), 'init', ...INIT_ARGS],
      cwd: root,
      stdio: 'inherit',
    })
    expect(handOff?.env.AGENT_QA_HANDED_OFF).toBe('1')
    expect(stderr()).toContain(
      `Handing over to the project's agent-qa 99.0.0 (node_modules/agent-qa), which is newer than this one (${VERSION}).`,
    )
    expect(configured(root)).toBe(false)
  })

  describe("the project agent-qa's own exit decides init's code after a Ctrl-C both heard", () => {
    const heard = { signal: null, output: '', cancelled: true } as const
    const exits: [string, RunResult, number | undefined][] = [
      ['a clean exit after its dashboard stopped exits 0', { ...heard, code: 0 }, undefined],
      ['an exit 3 after a failed step exits 3', { ...heard, code: 3 }, 3],
      ['an exit 130 exits 130', { ...heard, code: 130 }, 130],
      ['death by SIGINT exits 130', { ...heard, code: null, signal: 'SIGINT' }, 130],
    ]

    for (const [label, result, expected] of exits) {
      it(label, async () => {
        const { root, home } = tempProject('hand-off-ctrl-c')
        writeCopy(root, '99.0.0')
        const run = machine(installsCopy('99.0.0'), () => result)

        const outcome = init(root, home, run)

        if (expected === undefined) await expect(outcome).resolves.toBeUndefined()
        else expect((await refusal(outcome)).exitCode).toBe(expected)
        expect(commands(run).map((call) => call.stdio)).toEqual(['inherit'])
      })
    }
  })

  it('under --pm none a declared newer agent-qa is not installed and nothing takes over', async () => {
    const { root, home } = tempProject('hand-off-pm-none')
    declare(root, '99.0.0')
    const run = machine(installsCopy('99.0.0'))

    await expect(init(root, home, run, [...INIT_ARGS, '--pm', 'none'])).resolves.toBeUndefined()

    expect(managerAndHandOffCalls(run)).toEqual([])
    expect(configured(root)).toBe(true)
  })

  it('a declared range is never installed first and never compared', async () => {
    const { root, home } = tempProject('hand-off-range')
    declare(root, '^99.0.0')
    const configuredAtInstall: boolean[] = []
    const run = machine((call) => {
      configuredAtInstall.push(configured(root))
      return installsCopy('99.0.0')(call)
    })

    await expect(init(root, home, run)).resolves.toBeUndefined()

    expect(commands(run).map(argv)).toEqual(['npm install'])
    expect(configuredAtInstall).toEqual([true])
  })

  it('a file: spec is never compared, and its copy at this version does not take over', async () => {
    const { root, home } = tempProject('hand-off-file-spec')
    declare(root, 'file:../agent-qa')
    writeCopy(root, VERSION)
    const run = machine(installsCopy('99.0.0'))

    await expect(init(root, home, run)).resolves.toBeUndefined()

    expect(managerAndHandOffCalls(run)).toEqual([])
    expect(configured(root)).toBe(true)
  })

  it('a failed install before the hand-off leaves init to this agent-qa, which sets up the folder and exits 3', async () => {
    const { root, home } = tempProject('hand-off-install-fails')
    declare(root, '99.0.0')
    const run = machine(() => ({ code: 1, signal: null, output: 'npm error 404 Not Found\n' }))

    const error = await refusal(init(root, home, run))

    expect(reportCliFailure(error, failureDeps())).toBe(3)
    expect(commands(run).map(argv)).toEqual(['npm install', 'npm install'])
    const lines = stderr().split('\n')
    expect(lines.filter((line) => line === '✗ Install failed: npm exited 1')).toHaveLength(2)
    expect(lines).toContain(
      `The project's agent-qa 99.0.0 is not installed, so this one (${VERSION}) sets up the folder.`,
    )
    expect(lines).toContain('  Run: npm install')
    expect(stderr()).toContain('\nNext steps\n')
    expect(log).not.toHaveBeenCalled()
    expect(configured(root)).toBe(true)
  })

  it('first-party entries follow a declared newer agent-qa, the version the install leaves in place', async () => {
    const { root, home } = tempProject('hand-off-pins-follow-the-declared-version')
    declare(root, '99.0.0')
    const run = machine(() => ({ code: 1, signal: null, output: 'npm error 404 Not Found\n' }))

    const error = await refusal(init(root, home, run, ['--platform', 'web', '--llm', 'codex']))

    expect(reportCliFailure(error, failureDeps())).toBe(3)
    expect(devDependencies(root)).toEqual({
      'agent-qa': '99.0.0',
      '@vostride/agent-qa-subscription-auth': '99.0.0',
    })
  })

  it('under --pm none first-party entries follow a declared newer agent-qa', async () => {
    const { root, home } = tempProject('hand-off-pm-none-pins')
    declare(root, '99.0.0')
    const run = machine(installsCopy('99.0.0'))

    await expect(
      init(root, home, run, ['--platform', 'web', '--llm', 'codex', '--pm', 'none']),
    ).resolves.toBeUndefined()

    expect(managerAndHandOffCalls(run)).toEqual([])
    expect(devDependencies(root)).toEqual({
      'agent-qa': '99.0.0',
      '@vostride/agent-qa-subscription-auth': '99.0.0',
    })
  })

  it('an older declared agent-qa is pinned up, and first-party entries follow this one', async () => {
    const { root, home } = tempProject('hand-off-older-declared')
    declare(root, '0.0.1')
    const run = machine(installsCopy('0.0.1'))

    await expect(
      init(root, home, run, ['--platform', 'web', '--llm', 'codex', '--pm', 'none']),
    ).resolves.toBeUndefined()

    expect(devDependencies(root)).toEqual({
      'agent-qa': VERSION,
      '@vostride/agent-qa-subscription-auth': VERSION,
    })
  })

  it('a malformed package.json is refused before a re-run starts', async () => {
    const { root, home } = tempProject('hand-off-malformed')
    writeFileSync(join(root, 'agent-qa.config.yaml'), 'workspace: {}\n')
    writeFileSync(join(root, 'package.json'), '{ not json')
    const run = machine(installsCopy('99.0.0'))

    const error = await refusal(init(root, home, run))

    expect(reportCliFailure(error, failureDeps())).toBe(2)
    expect(error.message).toMatch(
      new RegExp(
        `^Refusing to update ${join(realpathSync(root), 'package.json').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: it is not valid JSON \\(`,
        'u',
      ),
    )
    expect(readFileSync(join(root, 'agent-qa.config.yaml'), 'utf-8')).toBe('workspace: {}\n')
    expect(managerAndHandOffCalls(run)).toEqual([])
  })
})
