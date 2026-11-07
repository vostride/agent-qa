// init's install step: one plain install through an injected runner, on real temporary folders.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { reportCliFailure } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import { runInstallStep } from '../commands/package-install.js'
import { planPackageJson, readProjectPackageJson } from '../commands/package-json-plan.js'
import { detectPackageManager } from '../commands/package-manager.js'
import { projectHost, type RunOptions, type RunResult } from '../commands/project-host.js'
import { projectRange } from '../commands/project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from '../commands/scaffold-content.js'
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
let log: MockInstance<typeof console.log>

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-install-step', runtimeContext: 'user' }),
  })

type Install = (call: { command: string; args: readonly string[]; options: RunOptions }) => RunResult

function isProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

// A command listed as null is not on PATH; an unlisted one answers --version with no output.
function onMachine(versions: Record<string, string | null>, install: Install): FakeRunner {
  return fakeRunner((call) => {
    if (!isProbe(call.args)) return install(call)
    const version = versions[call.command]
    if (version === null) return { code: null, signal: null, output: '', missing: true }
    return { code: 0, signal: null, output: version === undefined ? '' : `${version}\n` }
  })
}

function writes(...names: string[]): Install {
  return ({ options }) => {
    for (const name of names) writeInstalledPackage(options.cwd, name, VERSION)
    return { code: 0, signal: null, output: '' }
  }
}

function installing(...names: string[]): FakeRunner {
  return onMachine({}, writes(...names))
}

function installs(run: FakeRunner): RunnerCall[] {
  return run.calls.filter((call) => !isProbe(call.args))
}

function argv(call: RunnerCall): string {
  return [call.command, ...call.args].join(' ')
}

async function init(
  cwd: string,
  home: string,
  run: FakeRunner,
  args: readonly string[] = ['--platform', 'web', '--llm', 'gemini'],
): Promise<void> {
  const parent = new Command()
  const command = createInitCommand({
    cwd,
    host: { homedir: home, env: {}, run },
    isTTY: false,
    composeAnalytics: silentAnalytics,
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  await parent.parseAsync(['node', 'test', 'init', ...args])
}

function stdout(): string {
  return stripVTControlCharacters(
    log.mock.calls.map((call) => call.map(String).join(' ')).join('\n'),
  )
}

function writeJson(path: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path, text)
  return text
}

async function stepInput(root: string, home: string, run: FakeRunner) {
  const host = projectHost({ cwd: root, homedir: home, env: {}, run })
  const range = await projectRange(root, host)
  const packageJson = planPackageJson({
    ...readProjectPackageJson(range, host.io),
    folderName: 'project',
    dependencies: [{ name: 'agent-qa', version: VERSION }],
  })
  const manager = detectPackageManager({ range, env: host.env, io: host.io })
  return { host, range, packageJson, manager, print: (line: string) => console.log(line) }
}

describe('init installs what it declared', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('init runs one npm install in the folder that holds package.json', async () => {
    const { root, home } = tempProject('install-npm')
    const run = installing('agent-qa')

    await expect(init(root, home, run)).resolves.toBeUndefined()

    expect(installs(run)).toHaveLength(1)
    expect(installs(run)[0]).toMatchObject({
      command: 'npm',
      args: ['install'],
      cwd: realpathSync(root),
      stdio: 'capture',
    })
    const out = stdout()
    expect(out).toContain(`Installing agent-qa ${VERSION} with npm…`)
    expect(out).toContain(`✓ Installed agent-qa ${VERSION} with npm`)
    expect(out.indexOf('✓ Installed')).toBeLessThan(out.indexOf('agent-qa project initialized'))
  })

  it('a package.json above the folder is where the install runs, and the line names it', async () => {
    const { root, home } = tempProject('install-above')
    writeJson(join(root, 'package.json'), { name: 'above', private: true })
    const qa = join(root, 'qa')
    mkdirSync(qa)
    const run = installing('agent-qa')

    await init(qa, home, run)

    expect(installs(run)).toHaveLength(1)
    expect(installs(run)[0]!.cwd).toBe(realpathSync(root))
    expect(stdout()).toContain(
      `✓ Installed agent-qa ${VERSION} with npm; declared in ../package.json`,
    )
  })

  it('--pm pnpm installs with pnpm install', async () => {
    const { root, home } = tempProject('install-pnpm')
    const run = installing('agent-qa')

    await init(root, home, run, ['--platform', 'web', '--llm', 'gemini', '--pm', 'pnpm'])

    expect(installs(run).map(argv)).toEqual(['pnpm install'])
    expect(stdout()).toContain(`✓ Installed agent-qa ${VERSION} with pnpm`)
  })

  it('a claude-code init installs the subscription plugin in the same single call', async () => {
    const { root, home } = tempProject('install-subscription')
    const run = installing('agent-qa', SUBSCRIPTION_AUTH_PACKAGE)

    await init(root, home, run, ['--platform', 'web', '--llm', 'claude-code'])

    expect(installs(run).map(argv)).toEqual(['npm install'])
    expect(stdout()).toContain(
      `✓ Installed agent-qa ${VERSION} and ${SUBSCRIPTION_AUTH_PACKAGE} ${VERSION} with npm`,
    )
  })

  it('--pm none runs no install', async () => {
    const { root, home } = tempProject('install-none')
    const run = installing('agent-qa')

    await init(root, home, run, ['--platform', 'web', '--llm', 'gemini', '--pm', 'none'])

    expect(run.calls).toHaveLength(0)
    expect(stdout()).toContain(`Declared agent-qa ${VERSION} in package.json.`)
  })

  it('nothing runs when package.json is unchanged and every package is already installed', async () => {
    const { root, home } = tempProject('install-skip')
    writeJson(join(root, 'package.json'), {
      name: 'skip',
      private: true,
      devDependencies: { 'agent-qa': VERSION },
    })
    writeInstalledPackage(root, 'agent-qa', VERSION)
    const run = installing('agent-qa')
    const input = await stepInput(root, home, run)
    expect(input.packageJson.changed).toBe(false)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('skipped')
    expect(run.calls).toHaveLength(0)
    expect(stdout()).toBe(`✓ agent-qa ${VERSION} is already installed; nothing to install`)
  })

  it('the install still runs when init changed package.json, even with everything installed', async () => {
    const { root, home } = tempProject('install-changed')
    writeJson(join(root, 'package.json'), {
      name: 'changed',
      private: true,
      devDependencies: { 'agent-qa': `^${VERSION}` },
    })
    writeInstalledPackage(root, 'agent-qa', VERSION)
    const run = installing('agent-qa')
    const input = await stepInput(root, home, run)
    expect(input.packageJson.changed).toBe(true)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(installs(run)).toHaveLength(1)
  })

  it('an installed package at another version does not skip the install', async () => {
    const { root, home } = tempProject('install-other-version')
    writeJson(join(root, 'package.json'), {
      name: 'other',
      private: true,
      devDependencies: { 'agent-qa': VERSION },
    })
    writeInstalledPackage(root, 'agent-qa', '0.0.1')
    const run = installing('agent-qa')
    const input = await stepInput(root, home, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(installs(run)).toHaveLength(1)
  })
})

function failing(code: number | null, output: string): FakeRunner {
  return onMachine({}, () => ({ code, signal: null, output }))
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

describe('a failed install is a failed step', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('prints ✗, the last 20 output lines and the command, finishes init and exits 3', async () => {
    const { root, home } = tempProject('install-fails')
    const lines = Array.from({ length: 29 }, (_, index) => `npm line ${index + 1}`)
    const run = failing(1, `${[...lines, 'npm error 404 Not Found'].join('\n')}\n`)

    const error = await refusal(init(root, home, run))

    expect(error.exitCode).toBe(3)
    expect(error.lines).toEqual([])
    expect(reportCliFailure(error, failureDeps())).toBe(3)
    const out = stdout().split('\n')
    const at = out.indexOf('✗ Install failed: npm exited 1')
    expect(at).toBeGreaterThanOrEqual(0)
    const expected = [...lines.slice(10), 'npm error 404 Not Found'].map((line) => `  ${line}`)
    expect(out.slice(at + 1, at + 21)).toEqual(expected)
    expect(out[at + 21]).toBe('  Run: npm install')
    expect(out.join('\n')).not.toContain('npm line 10\n')
    expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(true)
    expect(out.join('\n')).toContain('agent-qa project initialized')
    expect(out.join('\n')).toContain('Next steps:')
  })

  it('the command names the folder holding package.json when init ran below it', async () => {
    const { root, home } = tempProject('install-fails-above')
    writeJson(join(root, 'package.json'), { name: 'above', private: true })
    const qa = join(root, 'qa')
    mkdirSync(qa)

    const error = await refusal(init(qa, home, failing(1, 'npm error boom\n')))

    expect(error.exitCode).toBe(3)
    expect(stdout()).toContain('  Run: cd .. && npm install')
  })

  it('a zero exit that left a package missing is a failed step', async () => {
    const { root, home } = tempProject('install-zero-missing')

    const error = await refusal(init(root, home, failing(0, '')))

    expect(error.exitCode).toBe(3)
    expect(stdout()).toContain(
      `✗ Install failed: npm exited 0, but agent-qa ${VERSION} is not installed`,
    )
    expect(stdout()).toContain('  Run: npm install')
  })

  it('a manager that is not found anywhere is a failed step with the command that ran', async () => {
    const { root, home } = tempProject('install-missing-manager')
    const run = onMachine({ npm: null, corepack: null }, () => ({
      code: null,
      signal: null,
      output: '',
      missing: true,
    }))

    const error = await refusal(init(root, home, run))

    expect(error.exitCode).toBe(3)
    expect(stdout()).toContain('✗ Install failed: npx was not found')
    expect(stdout()).toContain('  Run: npx -y npm install')
  })

  it('credentials and declared secrets in the output print masked', async () => {
    const { root, home } = tempProject('install-masked')
    writeFileSync(join(root, '.env.secrets.local'), 'REGISTRY_PASSWORD=declared-v4lue-9x7\n')
    const output = [
      'GET https://user:s3cret@registry.example.com/x',
      '//registry.example.com/:_authToken=abc123',
      'Authorization: Bearer abc.def',
      'login failed with declared-v4lue-9x7',
    ].join('\n')

    const error = await refusal(init(root, home, failing(1, output)))

    expect(error.exitCode).toBe(3)
    const out = stdout()
    expect(out).toContain('  GET https://user:***@registry.example.com/x')
    expect(out).toContain('  //registry.example.com/:_authToken=***')
    expect(out).toContain('  Authorization: Bearer ***')
    for (const secret of ['s3cret', 'abc123', 'abc.def', 'declared-v4lue-9x7']) {
      expect(out).not.toContain(secret)
    }
  })
})

async function declaredProject(
  label: string,
  manifest: Record<string, unknown>,
  run: FakeRunner,
  files: Record<string, string> = {},
) {
  const { root, home } = tempProject(label)
  writeJson(join(root, 'package.json'), { name: label, private: true, ...manifest })
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content)
  return { root, input: await stepInput(root, home, run) }
}

function lastLine(): string {
  return stdout().split('\n').at(-1) ?? ''
}

describe('a manager the machine lacks installs at the declared version', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('a declared pnpm that is not on PATH runs through corepack at its version', async () => {
    const run = onMachine({ pnpm: null, corepack: '0.36.0' }, writes('agent-qa'))
    const { input } = await declaredProject('corepack-pnpm', { packageManager: 'pnpm@12.17.0' }, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(installs(run).map(argv)).toEqual(['corepack pnpm@12.17.0 install'])
    expect(lastLine()).toBe(`✓ Installed agent-qa ${VERSION} with pnpm; through corepack`)
  })

  it('without corepack a declared pnpm runs through npx at its version', async () => {
    const run = onMachine({ pnpm: null, corepack: null }, writes('agent-qa'))
    const { input } = await declaredProject('npx-pnpm', { packageManager: 'pnpm@12.17.0' }, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(installs(run).map(argv)).toEqual(['npx -y pnpm@12.17.0 install'])
    expect(lastLine()).toBe(`✓ Installed agent-qa ${VERSION} with pnpm; through npx`)
  })

  it('Yarn 1 on PATH does not install a project that declares Yarn 4', async () => {
    const run = onMachine({ yarn: '1.22.19', corepack: null }, writes('agent-qa'))
    const { input } = await declaredProject('npx-yarn', { packageManager: 'yarn@4.18.1' }, run)

    await runInstallStep({ ...input, mode: 'run' })

    expect(installs(run).map(argv)).toEqual(['npx -y -p @yarnpkg/cli-dist@4.18.1 yarn install'])
  })

  it('with corepack a declared Yarn 4 runs through corepack when PATH has Yarn 1', async () => {
    const run = onMachine({ yarn: '1.22.19', corepack: '0.36.0' }, writes('agent-qa'))
    const { input } = await declaredProject('corepack-yarn', { packageManager: 'yarn@4.18.1' }, run)

    await runInstallStep({ ...input, mode: 'run' })

    expect(installs(run).map(argv)).toEqual(['corepack yarn@4.18.1 install'])
  })

  it('a declared Yarn 1 that is not on PATH runs through the yarn package on npx', async () => {
    const run = onMachine({ yarn: null, corepack: null }, writes('agent-qa'))
    const { input } = await declaredProject('npx-yarn1', { packageManager: 'yarn@1.22.22' }, run)

    await runInstallStep({ ...input, mode: 'run' })

    expect(installs(run).map(argv)).toEqual(['npx -y yarn@1.22.22 install'])
  })

  it('a declared bun that is not on PATH runs through npx and never through corepack', async () => {
    const run = onMachine({ bun: null, corepack: '0.36.0' }, writes('agent-qa'))
    const { input } = await declaredProject('npx-bun', { packageManager: 'bun@1.3.14' }, run)

    await runInstallStep({ ...input, mode: 'run' })

    expect(installs(run).map(argv)).toEqual(['npx -y bun@1.3.14 install'])
    expect(run.calls.some((call) => call.command === 'corepack')).toBe(false)
  })

  it('an npm on PATH at another major runs the declared npm through npx', async () => {
    const run = onMachine({ npm: '10.9.2', corepack: null }, writes('agent-qa'))
    const { input } = await declaredProject('npx-npm', { packageManager: 'npm@11.20.0' }, run)

    await runInstallStep({ ...input, mode: 'run' })

    expect(installs(run).map(argv)).toEqual(['npx -y npm@11.20.0 install'])
  })

  it('a PATH pnpm at the declared major runs as itself', async () => {
    const run = onMachine({ pnpm: '12.16.1' }, writes('agent-qa'))
    const { input } = await declaredProject('path-pnpm', { packageManager: 'pnpm@12.17.0' }, run)

    await runInstallStep({ ...input, mode: 'run' })

    expect(installs(run).map(argv)).toEqual(['pnpm install'])
    expect(lastLine()).toBe(`✓ Installed agent-qa ${VERSION} with pnpm`)
  })

  it('a lockfile with no declared version runs the manager through npx without a version', async () => {
    const run = onMachine({ pnpm: null, corepack: null }, writes('agent-qa'))
    const { input } = await declaredProject('npx-lockfile', {}, run, { 'pnpm-lock.yaml': '' })

    await runInstallStep({ ...input, mode: 'run' })

    expect(installs(run).map(argv)).toEqual(['npx -y pnpm install'])
  })

  it('a failed install through npx prints that command to run', async () => {
    const run = onMachine({ pnpm: null, corepack: null }, () => ({
      code: 1,
      signal: null,
      output: 'ERR_PNPM_FETCH_404\n',
    }))
    const { input } = await declaredProject('npx-fails', { packageManager: 'pnpm@12.17.0' }, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('failed')
    expect(result.command).toBe('npx -y pnpm@12.17.0 install')
    expect(lastLine()).toBe('  Run: npx -y pnpm@12.17.0 install')
  })
})
