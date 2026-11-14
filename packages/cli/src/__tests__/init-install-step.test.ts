// init's install step: one plain install through an injected runner, on real temporary folders.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { reportCliFailure } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import { installOutputMask, OUTPUT_HIDDEN, runInstallStep } from '../commands/package-install.js'
import { planPackageJson, readProjectPackageJson } from '../commands/package-json-plan.js'
import { detectPackageManager, managerEnv } from '../commands/package-manager.js'
import {
  projectHost,
  spawnRunner,
  type CommandRunner,
  type RunOptions,
  type RunResult,
} from '../commands/project-host.js'
import { projectRange } from '../commands/project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from '../commands/scaffold-content.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
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
let errors: MockInstance<typeof process.stderr.write>

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-install-step', runtimeContext: 'user' }),
  })

type Install = (call: {
  command: string
  args: readonly string[]
  options: RunOptions
}) => RunResult

function isProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

// A command listed as null is not on PATH; an unlisted one answers --version with no output.
// init's validate step passes, so the install is the only call a cell scripts.
function onMachine(versions: Record<string, string | null>, install: Install): FakeRunner {
  return fakeRunner((call) => {
    if (call.args.includes('validate')) return { code: 0, signal: null, output: '' }
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

// init's validate step runs through agent-qa after the install; these cells are about the manager.
function managerCalls(run: FakeRunner): RunnerCall[] {
  return run.calls.filter((call) => !call.args.includes('validate'))
}

function installs(run: FakeRunner): RunnerCall[] {
  return managerCalls(run).filter((call) => !isProbe(call.args))
}

function argv(call: RunnerCall): string {
  return [call.command, ...call.args].join(' ')
}

async function init(
  cwd: string,
  home: string,
  run: CommandRunner,
  args: readonly string[] = ['--platform', 'web', '--llm', 'gemini'],
  ui?: FakeInitUi,
): Promise<void> {
  const parent = new Command()
  const command = createInitCommand({
    cwd,
    host: { homedir: home, env: {}, run },
    isTTY: false,
    composeAnalytics: silentAnalytics,
    ...(ui === undefined ? {} : { ui }),
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  // The cells are about the install, so no Chromium or coding-agent step runs.
  const agents = args.includes('--agents') ? [] : ['--agents', 'none']
  await parent.parseAsync(['node', 'test', 'init', ...args, '--no-browsers', ...agents])
}

// runInstallStep prints through console.log in these cells; init draws its lines on stderr.
function printed(): string {
  const logged = log.mock.calls.map((call) => call.map(String).join(' '))
  const drawn = errors.mock.calls.map((call) => String(call[0])).join('')
  const lines = drawn === '' ? logged : [...logged, ...drawn.replace(/\n$/u, '').split('\n')]
  return stripVTControlCharacters(lines.join('\n'))
}

function writeJson(path: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path, text)
  return text
}

async function stepInput(
  root: string,
  home: string,
  run: CommandRunner,
  env: NodeJS.ProcessEnv = {},
) {
  const host = projectHost({ cwd: root, homedir: home, env, run })
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
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
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
    const out = printed()
    expect(out).not.toContain(`Installing agent-qa ${VERSION} with npm…`)
    expect(out).toContain(`✓ Installed agent-qa ${VERSION} with npm\n`)
    expect(out.indexOf('✓ Scaffold:')).toBeLessThan(out.indexOf('✓ Installed'))
    expect(out.indexOf('✓ Installed')).toBeLessThan(out.indexOf('Next steps'))
    expect(log).not.toHaveBeenCalled()
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
    expect(printed()).toContain(
      `✓ Installed agent-qa ${VERSION} with npm; declared in ../package.json`,
    )
  })

  it('--pm pnpm installs with pnpm install', async () => {
    const { root, home } = tempProject('install-pnpm')
    const run = installing('agent-qa')

    await init(root, home, run, ['--platform', 'web', '--llm', 'gemini', '--pm', 'pnpm'])

    expect(installs(run).map(argv)).toEqual(['pnpm install'])
    expect(printed()).toContain(`✓ Installed agent-qa ${VERSION} with pnpm`)
  })

  it('a claude-code init installs the subscription plugin in the same single call', async () => {
    const { root, home } = tempProject('install-subscription')
    const run = installing('agent-qa', SUBSCRIPTION_AUTH_PACKAGE)

    await init(root, home, run, ['--platform', 'web', '--llm', 'claude-code'])

    expect(installs(run).map(argv)).toEqual(['npm install'])
    expect(printed()).toContain(
      `✓ Installed agent-qa ${VERSION} and ${SUBSCRIPTION_AUTH_PACKAGE} ${VERSION} with npm`,
    )
  })

  it('--pm none runs no install', async () => {
    const { root, home } = tempProject('install-none')
    const run = installing('agent-qa')

    await init(root, home, run, ['--platform', 'web', '--llm', 'gemini', '--pm', 'none'])

    expect(managerCalls(run)).toHaveLength(0)
    expect(printed()).toContain(`Declared agent-qa ${VERSION} in package.json.`)
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
    expect(managerCalls(run)).toHaveLength(0)
    expect(printed()).toBe(`✓ agent-qa ${VERSION} is already installed; nothing to install`)
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
    capture: () => {},
    settle: async () => {},
    flush: async () => {},
    exit: () => {},
    env: {},
  }
}

describe('a failed install is a failed step', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
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
    const out = printed().split('\n')
    const at = out.indexOf('✗ Install failed: npm exited 1')
    expect(at).toBeGreaterThanOrEqual(0)
    const expected = [...lines.slice(10), 'npm error 404 Not Found'].map((line) => `  ${line}`)
    expect(out.slice(at + 1, at + 21)).toEqual(expected)
    expect(out[at + 21]).toBe('  Run: npm install')
    expect(out.join('\n')).not.toContain('npm line 10\n')
    expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(true)
    const scaffoldLine =
      /^✓ Scaffold: config, 2 starter tests, a suite of 3 and a hook test \(\d+ files\)$/u
    const scaffold = out.findIndex((line) => scaffoldLine.test(line))
    expect(scaffold).toBeGreaterThanOrEqual(0)
    expect(scaffold).toBeLessThan(at)
    expect(out.indexOf('Next steps')).toBeGreaterThan(at + 21)
  })

  it('the command names the folder holding package.json when init ran below it', async () => {
    const { root, home } = tempProject('install-fails-above')
    writeJson(join(root, 'package.json'), { name: 'above', private: true })
    const qa = join(root, 'qa')
    mkdirSync(qa)

    const error = await refusal(init(qa, home, failing(1, 'npm error boom\n')))

    expect(error.exitCode).toBe(3)
    expect(printed()).toContain('  Run: cd .. && npm install')
  })

  it('a zero exit that left a package missing is a failed step', async () => {
    const { root, home } = tempProject('install-zero-missing')

    const error = await refusal(init(root, home, failing(0, '')))

    expect(error.exitCode).toBe(3)
    expect(printed()).toContain(
      `✗ Install failed: npm exited 0, but agent-qa ${VERSION} is not installed`,
    )
    expect(printed()).toContain('  Run: npm install')
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
    expect(printed()).toContain('✗ Install failed: npx was not found')
    expect(printed()).toContain('  Run: npx -y npm install')
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
    const out = printed()
    expect(out).toContain('  GET https://user:***@registry.example.com/x')
    expect(out).toContain('  //registry.example.com/:_authToken=***')
    expect(out).toContain('  Authorization: Bearer ***')
    for (const secret of ['s3cret', 'abc123', 'abc.def', 'declared-v4lue-9x7']) {
      expect(out).not.toContain(secret)
    }
  })
})

describe('failure output and the declared-secret mask', () => {
  const SECRET = 'reg1stry-t0ken-only-in-output'
  const CONFIG = [
    'workspace:',
    '  testMatch:',
    '    - tests/**/*.yaml',
    '  suiteMatch:',
    '    - suites/**/*.suite.yaml',
    '  hooksFile: hooks.yaml',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    '',
  ].join('\n')

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  async function failedStep(root: string, home: string) {
    const input = await stepInput(root, home, failing(1, `npm error fetch failed ${SECRET}\n`))
    const mask = installOutputMask(join(root, 'agent-qa.config.yaml'), input.host.io)
    return runInstallStep({ ...input, mode: 'run', mask })
  }

  it('a secrets file that exists but cannot be read hides the output and keeps the command', async () => {
    const { root, home } = tempProject('install-mask-unreadable')
    writeFileSync(join(root, 'agent-qa.config.yaml'), CONFIG)
    mkdirSync(join(root, '.env.secrets.local'))

    const result = await failedStep(root, home)

    expect(result.outcome).toBe('failed')
    const out = printed()
    expect(out).toContain(`  ${OUTPUT_HIDDEN}`)
    expect(out).toContain('  Run: npm install')
    expect(out).not.toContain(SECRET)
  })

  it('a config that is not there yet declares nothing, so the output prints', async () => {
    const { root, home } = tempProject('install-mask-no-config')

    await failedStep(root, home)

    expect(printed()).toContain(`  npm error fetch failed ${SECRET}`)
    expect(printed()).not.toContain(OUTPUT_HIDDEN)
  })

  it('a config whose secrets file does not exist declares nothing, so the output prints', async () => {
    const { root, home } = tempProject('install-mask-no-secrets')
    writeFileSync(join(root, 'agent-qa.config.yaml'), CONFIG)

    await failedStep(root, home)

    expect(printed()).toContain(`  npm error fetch failed ${SECRET}`)
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
  return printed().split('\n').at(-1) ?? ''
}

describe('a manager the machine lacks installs at the declared version', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('a declared pnpm that is not on PATH runs through corepack at its version', async () => {
    const run = onMachine({ pnpm: null, corepack: '0.36.0' }, writes('agent-qa'))
    const manifest = { packageManager: 'pnpm@12.17.0' }
    const { input } = await declaredProject('corepack-pnpm', manifest, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(installs(run).map(argv)).toEqual(['corepack pnpm@12.17.0 install'])
    expect(lastLine()).toBe(
      `✓ Installed agent-qa ${VERSION} with pnpm; through corepack; ${DENIED_NOTE}`,
    )
  })

  it('without corepack a declared pnpm runs through npx at its version', async () => {
    const run = onMachine({ pnpm: null, corepack: null }, writes('agent-qa'))
    const { input } = await declaredProject('npx-pnpm', { packageManager: 'pnpm@12.17.0' }, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(installs(run).map(argv)).toEqual(['npx -y pnpm@12.17.0 install'])
    expect(lastLine()).toBe(
      `✓ Installed agent-qa ${VERSION} with pnpm; through npx; ${DENIED_NOTE}`,
    )
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
    expect(lastLine()).toBe(`✓ Installed agent-qa ${VERSION} with pnpm; ${DENIED_NOTE}`)
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

const ERESOLVE_OUTPUT = [
  'npm error code ERESOLVE',
  'npm error ERESOLVE unable to resolve dependency tree',
  'npm error Fix the upstream dependency conflict, or retry this command with --force or --legacy-peer-deps',
].join('\n')

function eresolveUntilLegacy(legacyWorks: boolean): Install {
  return ({ args, options }) => {
    if (legacyWorks && args.includes('--legacy-peer-deps')) {
      writeInstalledPackage(options.cwd, 'agent-qa', VERSION)
      return { code: 0, signal: null, output: '' }
    }
    return { code: 1, signal: null, output: ERESOLVE_OUTPUT }
  }
}

describe('the install holds up under CI, npx, peer conflicts and Ctrl-C', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('the probes and the install get the filtered environment, and no value of it prints', async () => {
    const { root, home } = tempProject('install-env')
    writeJson(join(root, 'package.json'), { name: 'env', private: true })
    const env: NodeJS.ProcessEnv = {
      PATH: '/env-path-value',
      CI: 'true',
      NODE_ENV: 'production',
      npm_command: 'exec',
      npm_lifecycle_event: 'npx',
      npm_config_allow_scripts: '',
      npm_config_registry: 'https://env-registry-value.example',
    }
    const run = onMachine({ pnpm: null, corepack: '0.36.0' }, writes('agent-qa'))
    const input = await stepInput(root, home, run, env)

    await runInstallStep({ ...input, manager: { name: 'pnpm', source: 'flag' }, mode: 'run' })

    expect(run.calls.map((call) => [argv(call), call.env])).toEqual([
      ['pnpm --version', managerEnv('pnpm', 'path', env)],
      ['corepack --version', managerEnv('pnpm', 'corepack', env)],
      ['corepack pnpm install', managerEnv('pnpm', 'corepack', env)],
    ])
    expect(run.calls.at(-1)!.env).toMatchObject({
      CI: 'true',
      PNPM_CONFIG_FROZEN_LOCKFILE: 'false',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    })
    expect(run.calls.at(-1)!.env.NODE_ENV).toBeUndefined()
    for (const value of ['/env-path-value', 'env-registry-value', 'production']) {
      expect(printed()).not.toContain(value)
    }
  })

  it("npm's peer conflict is retried once with --legacy-peer-deps and nothing goes to .npmrc", async () => {
    const { root, home } = tempProject('install-eresolve')
    const run = onMachine({}, eresolveUntilLegacy(true))
    const input = await stepInput(root, home, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(installs(run).map(argv)).toEqual(['npm install', 'npm install --legacy-peer-deps'])
    expect(lastLine()).toBe(
      `✓ Installed agent-qa ${VERSION} with npm; installed with --legacy-peer-deps: npm found a peer conflict`,
    )
    expect(existsSync(join(root, '.npmrc'))).toBe(false)
  })

  it('a second peer conflict is a failed step whose command carries --legacy-peer-deps', async () => {
    const { root, home } = tempProject('install-eresolve-twice')
    const run = onMachine({}, eresolveUntilLegacy(false))
    const input = await stepInput(root, home, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('failed')
    expect(installs(run).map(argv)).toEqual(['npm install', 'npm install --legacy-peer-deps'])
    expect(printed()).toContain('✗ Install failed: npm exited 1')
    expect(lastLine()).toBe('  Run: npm install --legacy-peer-deps')
  })

  it('ERESOLVE in the output of a manager other than npm is not retried', async () => {
    const { root, home } = tempProject('install-eresolve-pnpm')
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    const run = onMachine({ pnpm: '12.16.1' }, eresolveUntilLegacy(true))
    const input = await stepInput(root, home, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('failed')
    expect(installs(run).map(argv)).toEqual(['pnpm install'])
    expect(lastLine()).toBe('  Run: pnpm install')
  })

  it.each([
    ['a cancelled run', { code: null, signal: 'SIGINT', output: '', cancelled: true }],
    ['a run stopped by SIGINT', { code: null, signal: 'SIGINT', output: '' }],
  ] as const)(
    'Ctrl-C during the install prints Cancelled., exits 130 and keeps package.json declared: %s',
    async (_label, outcome) => {
      const { root, home } = tempProject('install-cancelled')
      const run = onMachine({}, () => ({ ...outcome }))

      const error = await init(root, home, run).then(
        () => undefined,
        (caught: unknown) => caught,
      )

      expect(error).toBeInstanceOf(PromptCancelled)
      const fixed: string[] = []
      const deps = { ...failureDeps(), printFixed: (line: string) => fixed.push(line) }
      expect(reportCliFailure(error, deps)).toBe(130)
      expect(fixed).toEqual(['Cancelled.'])
      expect(installs(run)).toHaveLength(1)
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        devDependencies?: Record<string, string>
      }
      expect(manifest.devDependencies?.['agent-qa']).toBe(VERSION)
      expect(printed()).toContain('✗ Installing dependencies: interrupted')
      expect(printed()).not.toContain('Next steps')
    },
  )
})

const DENIED_NOTE =
  'denied the build scripts of edgedriver, geckodriver, onnxruntime-node and protobufjs in pnpm-workspace.yaml'
const DENIED_FILE =
  'allowBuilds:\n  edgedriver: false\n  geckodriver: false\n  onnxruntime-node: false\n  protobufjs: false\n'
const IGNORED_BUILDS_OUTPUT = [
  ' ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild@0.25.0',
  'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
].join('\n')

function ignoredBuildsUntil(installedOnCall: number): Install {
  let call = 0
  return ({ options }) => {
    call += 1
    if (call < installedOnCall) return { code: 1, signal: null, output: IGNORED_BUILDS_OUTPUT }
    writeInstalledPackage(options.cwd, 'agent-qa', VERSION)
    return { code: 0, signal: null, output: '' }
  }
}

describe('a pnpm install denies the build scripts pnpm would stop on', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('init writes pnpm-workspace.yaml beside package.json before its single pnpm install', async () => {
    const { root, home } = tempProject('pnpm-deny')
    const seen: (string | undefined)[] = []
    const run = onMachine({}, ({ options }) => {
      const file = join(options.cwd, 'pnpm-workspace.yaml')
      seen.push(existsSync(file) ? readFileSync(file, 'utf8') : undefined)
      writeInstalledPackage(options.cwd, 'agent-qa', VERSION)
      return { code: 0, signal: null, output: '' }
    })

    await init(root, home, run, ['--platform', 'web', '--llm', 'gemini', '--pm', 'pnpm'])

    expect(installs(run).map(argv)).toEqual(['pnpm install'])
    expect(seen).toEqual([DENIED_FILE])
    expect(printed()).toContain(`✓ Installed agent-qa ${VERSION} with pnpm; ${DENIED_NOTE}`)
  })

  it('the pnpm-workspace.yaml at the workspace root above package.json is the one edited', async () => {
    const { root, home } = tempProject('pnpm-deny-workspace')
    const workspace = 'packages:\n  - apps/*\n'
    writeFileSync(join(root, 'pnpm-workspace.yaml'), workspace)
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    const app = join(root, 'apps', 'web')
    mkdirSync(app, { recursive: true })
    writeJson(join(app, 'package.json'), { name: 'web', private: true })
    const run = onMachine({ pnpm: '12.16.1' }, writes('agent-qa'))
    const input = await stepInput(app, home, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      `${workspace}${DENIED_FILE}`,
    )
    expect(existsSync(join(app, 'pnpm-workspace.yaml'))).toBe(false)
    expect(lastLine()).toBe(
      `✓ Installed agent-qa ${VERSION} with pnpm; ${DENIED_NOTE.replace(' in pnpm-workspace.yaml', ' in ../../pnpm-workspace.yaml')}`,
    )
  })

  it('an ignored-builds failure denies the builds pnpm named and installs once more', async () => {
    const { root, home } = tempProject('pnpm-ignored-builds')
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    const run = onMachine({ pnpm: '12.16.1' }, ignoredBuildsUntil(2))
    const input = await stepInput(root, home, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(installs(run).map(argv)).toEqual(['pnpm install', 'pnpm install'])
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      `${DENIED_FILE}  esbuild: false\n`,
    )
    expect(lastLine()).toBe(
      `✓ Installed agent-qa ${VERSION} with pnpm; ${DENIED_NOTE}; denied the build scripts of esbuild in pnpm-workspace.yaml`,
    )
  })

  it('a second ignored-builds failure is a failed step', async () => {
    const { root, home } = tempProject('pnpm-ignored-builds-twice')
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    const run = onMachine({ pnpm: '12.16.1' }, ignoredBuildsUntil(3))
    const input = await stepInput(root, home, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('failed')
    expect(installs(run).map(argv)).toEqual(['pnpm install', 'pnpm install'])
    expect(printed()).toContain('✗ Install failed: pnpm exited 1')
    expect(lastLine()).toBe('  Run: pnpm install')
  })

  it('a flow allowBuilds is not written, and the line says what to add', async () => {
    const { root, home } = tempProject('pnpm-deny-flow')
    const workspace = 'allowBuilds: { sharp: true }\n'
    writeFileSync(join(root, 'pnpm-workspace.yaml'), workspace)
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    const run = onMachine({ pnpm: '12.16.1' }, writes('agent-qa'))
    const input = await stepInput(root, home, run)

    await runInstallStep({ ...input, mode: 'run' })

    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(workspace)
    expect(lastLine()).toBe(
      `✓ Installed agent-qa ${VERSION} with pnpm; add edgedriver: false, geckodriver: false, onnxruntime-node: false and protobufjs: false under allowBuilds in pnpm-workspace.yaml`,
    )
  })

  it('--pm none in a pnpm project prepares pnpm-workspace.yaml and says so', async () => {
    const { root, home } = tempProject('pnpm-deny-none')
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    const run = installing('agent-qa')

    await init(root, home, run, ['--platform', 'web', '--llm', 'gemini', '--pm', 'none'])

    expect(managerCalls(run)).toHaveLength(0)
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(DENIED_FILE)
    expect(printed()).toContain(
      `Declared agent-qa ${VERSION} in package.json. Install with: pnpm install; ${DENIED_NOTE}`,
    )
  })

  it.each([
    ['npm', {}],
    ['Yarn', { 'yarn.lock': '# yarn lockfile v1\n' }],
    ['bun', { 'bun.lock': '' }],
  ] as const)('a %s project gets no pnpm-workspace.yaml', async (_label, files) => {
    const run = installing('agent-qa')
    const { root, input } = await declaredProject('no-pnpm-settings', {}, run, files)

    await runInstallStep({ ...input, mode: 'run' })

    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false)
  })
})

describe("a Yarn Plug'n'Play project installs into node_modules", () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('init sets nodeLinker in the Yarn 4 root .yarnrc.yml before the install', async () => {
    const { root, home } = tempProject('yarn-berry-linker')
    writeJson(join(root, 'package.json'), {
      name: 'berry',
      private: true,
      packageManager: 'yarn@4.18.1',
    })
    writeFileSync(join(root, 'yarn.lock'), '__metadata:\n  version: 8\n')
    const seen: (string | undefined)[] = []
    const run = onMachine({ yarn: '4.18.1' }, ({ options }) => {
      const file = join(options.cwd, '.yarnrc.yml')
      seen.push(existsSync(file) ? readFileSync(file, 'utf8') : undefined)
      writeInstalledPackage(options.cwd, 'agent-qa', VERSION)
      return { code: 0, signal: null, output: '' }
    })

    await init(root, home, run)

    expect(installs(run).map(argv)).toEqual(['yarn install'])
    expect(seen).toEqual(['nodeLinker: node-modules\n'])
    expect(printed()).toContain(
      `✓ Installed agent-qa ${VERSION} with yarn; set nodeLinker: node-modules in .yarnrc.yml`,
    )
  })

  it('a Yarn that nothing in the project dates takes the line of the yarn on PATH', async () => {
    const { root, home } = tempProject('yarn-line-from-path')
    const run = onMachine({ yarn: '4.5.0' }, writes('agent-qa'))

    await init(root, home, run, ['--platform', 'web', '--llm', 'gemini', '--pm', 'yarn'])

    expect(installs(run).map(argv)).toEqual(['yarn install'])
    expect(readFileSync(join(root, '.yarnrc.yml'), 'utf8')).toBe('nodeLinker: node-modules\n')
  })

  it('a Yarn 1 project gets no .yarnrc.yml', async () => {
    const run = onMachine({ yarn: '1.22.22' }, writes('agent-qa'))
    const { root, input } = await declaredProject('yarn-classic-linker', {}, run, {
      'yarn.lock': '# yarn lockfile v1\n',
    })

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result.outcome).toBe('installed')
    expect(existsSync(join(root, '.yarnrc.yml'))).toBe(false)
  })
})

const PLUGIN_STEP_DESCRIPTION = 'Install the subscription sign-in plugin'
const CLAUDE_CODE = ['--platform', 'web', '--llm', 'claude-code']
// Any npm install, i or add command that names the plugin, whatever its flags.
const NPM_PLUGIN_INSTALL = new RegExp(
  `npm (?:install|i|add)\\b.*${SUBSCRIPTION_AUTH_PACKAGE.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}`,
  'u',
)

// The commands in the plain Next steps box, in order.
function nextSteps(): string[] {
  const lines = printed().split('\n')
  const start = lines.indexOf('Next steps')
  // The box separates its groups with empty lines and ends at the first line outside it.
  const end = lines.findIndex(
    (line, index) => index > start && line !== '' && !line.startsWith('  '),
  )
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

describe("init's subscription next step", () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  it('an install that adds the plugin leaves no plugin next step', async () => {
    const { root, home } = tempProject('next-step-installed')
    const run = installing('agent-qa', SUBSCRIPTION_AUTH_PACKAGE)

    await init(root, home, run, CLAUDE_CODE)

    expect(printed()).not.toContain('plugins add')
    expect(printed()).not.toContain(PLUGIN_STEP_DESCRIPTION)
    expect(printed()).toContain('npx agent-qa auth login --config claude-code')
  })

  it('a failed install is followed by its plain install and the auth login line, with no plugins add line', async () => {
    const { root, home } = tempProject('next-step-failed')

    const error = await refusal(init(root, home, failing(1, 'npm error boom\n'), CLAUDE_CODE))

    expect(error.exitCode).toBe(3)
    expect(nextSteps()[0]).toBe('npm install')
    expect(nextSteps()).toContain('npx agent-qa auth login --config claude-code')
    expect(printed()).not.toContain('plugins add')
    expect(printed()).not.toMatch(NPM_PLUGIN_INSTALL)
  })

  it('--pm none is followed by the plain install and the auth login line, with no plugins add line', async () => {
    const { root, home } = tempProject('next-step-none')

    await init(root, home, installing(), [...CLAUDE_CODE, '--pm', 'none'])

    const steps = nextSteps()
    expect(steps[0]).toBe('npm install')
    expect(steps.indexOf('npx agent-qa validate')).toBeGreaterThan(0)
    expect(steps).toContain('npx agent-qa auth login --config claude-code')
    expect(printed()).not.toContain('plugins add')
    expect(printed()).not.toMatch(NPM_PLUGIN_INSTALL)
  })

  it('a plugin installed above the git root does not count: the plain install is still listed', async () => {
    const { root: outside, home } = tempProject('next-step-above')
    writeInstalledPackage(outside, SUBSCRIPTION_AUTH_PACKAGE, VERSION)
    const project = join(outside, 'app')
    mkdirSync(join(project, '.git'), { recursive: true })

    await init(project, home, installing(), [...CLAUDE_CODE, '--pm', 'none'])

    expect(nextSteps()).toContain('npm install')
    expect(nextSteps()).toContain('npx agent-qa auth login --config claude-code')
  })
})

// Exits 130 from its own Ctrl-C handler, which agent-qa's listener never sees.
const OWN_CTRL_C = [
  "process.on('SIGINT', () => process.exit(130))",
  "setTimeout(() => process.exit(0), 10_000)",
  "if (process.platform === 'win32') process.emit('SIGINT')",
  "else process.kill(process.pid, 'SIGINT')",
].join('\n')

const EACCES = () => Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })

function pnpmProject(label: string): { root: string; home: string } {
  const project = tempProject(label)
  writeFileSync(join(project.root, 'pnpm-lock.yaml'), '')
  return project
}

describe('a manager that cancels itself or a runner that throws', () => {
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupTempProjects()
  })

  // Probes answer from the fake machine; the install runs a real node child.
  function childOnInstall(script: string): CommandRunner {
    const probes = onMachine({}, () => ({ code: 0, signal: null, output: '' }))
    return (command, args, options) =>
      isProbe(args)
        ? probes(command, args, options)
        : spawnRunner(process.execPath, ['-e', script], options)
  }

  it('a manager that exits 130 from its own Ctrl-C handler is a cancel, not a failed install', async () => {
    const { root, home } = tempProject('install-own-ctrl-c')
    const before = process.listeners('SIGINT')
    const input = await stepInput(root, home, childOnInstall(OWN_CTRL_C))

    await expect(runInstallStep({ ...input, mode: 'run' })).rejects.toBeInstanceOf(
      PromptCancelled,
    )
    expect(process.listeners('SIGINT')).toEqual(before)
  }, 20_000)

  it('init over a manager that exits 130 on its own prints Cancelled. and exits 130', async () => {
    const { root, home } = tempProject('init-own-ctrl-c')
    const before = process.listeners('SIGINT')

    const error = await init(root, home, childOnInstall(OWN_CTRL_C)).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(PromptCancelled)
    const fixed: string[] = []
    const deps = { ...failureDeps(), printFixed: (line: string) => fixed.push(line) }
    expect(reportCliFailure(error, deps)).toBe(130)
    expect(fixed).toEqual(['Cancelled.'])
    expect(process.listeners('SIGINT')).toEqual(before)
  }, 20_000)

  it('a runner that throws on the install is a failed step with its message and command', async () => {
    const { root, home } = pnpmProject('install-throws')
    const run = onMachine({ pnpm: '10.0.0' }, () => {
      throw EACCES()
    })
    const input = await stepInput(root, home, run)

    const result = await runInstallStep({ ...input, mode: 'run' })

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'spawn EACCES',
      command: 'pnpm install',
    })
    const out = printed().split('\n')
    expect(out).toContain('✗ Install failed: spawn EACCES')
    expect(out.at(-1)).toBe('  Run: pnpm install')
  })

  it('init over a runner that throws on the install exits 3 with every step recorded', async () => {
    const { root, home } = pnpmProject('init-install-throws')
    const ui = fakeInitUi()
    const run = onMachine({ pnpm: '10.0.0' }, () => {
      throw EACCES()
    })

    const error = await refusal(init(root, home, run, undefined, ui))

    expect(reportCliFailure(error, failureDeps())).toBe(3)
    const done = ui.entries.filter((entry) => entry.kind === 'done').map((entry) => entry.text)
    expect(done).toHaveLength(3)
    expect(done.at(-1)).toBe('validate: the config and tests are valid')
    expect(ui.entries).toContainEqual({
      kind: 'failed',
      text: 'Install failed: spawn EACCES',
      command: 'pnpm install',
    })
    expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(true)
  })

  it('a version probe that throws is a failed install step with the install command to run', async () => {
    const { root, home } = pnpmProject('init-probe-throws')
    const ui = fakeInitUi()
    const run = fakeRunner(() => {
      throw EACCES()
    })

    const error = await refusal(init(root, home, run, undefined, ui))

    expect(reportCliFailure(error, failureDeps())).toBe(3)
    expect(managerCalls(run).map(argv)).toEqual(['pnpm --version'])
    expect(ui.entries).toContainEqual({
      kind: 'failed',
      text: 'Install failed: pnpm --version could not start: spawn EACCES',
      command: 'pnpm install',
    })
    const note = ui.entries.find((entry) => entry.kind === 'note' && entry.text === 'Next steps')
    const steps = note?.kind === 'note' ? note.lines : []
    expect(steps[0]).toBe('pnpm install')
    expect(steps).not.toContain('pnpm --version')
  })
})
