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
import { projectHost } from '../commands/project-host.js'
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

function installing(...names: string[]): FakeRunner {
  return fakeRunner(({ options }) => {
    for (const name of names) writeInstalledPackage(options.cwd, name, VERSION)
    return { code: 0, signal: null, output: '' }
  })
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

    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]).toMatchObject({
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

    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]!.cwd).toBe(realpathSync(root))
    expect(stdout()).toContain(
      `✓ Installed agent-qa ${VERSION} with npm; declared in ../package.json`,
    )
  })

  it('--pm pnpm installs with pnpm install', async () => {
    const { root, home } = tempProject('install-pnpm')
    const run = installing('agent-qa')

    await init(root, home, run, ['--platform', 'web', '--llm', 'gemini', '--pm', 'pnpm'])

    expect(run.calls.map((call) => [call.command, call.args])).toEqual([['pnpm', ['install']]])
    expect(stdout()).toContain(`✓ Installed agent-qa ${VERSION} with pnpm`)
  })

  it('a claude-code init installs the subscription plugin in the same single call', async () => {
    const { root, home } = tempProject('install-subscription')
    const run = installing('agent-qa', SUBSCRIPTION_AUTH_PACKAGE)

    await init(root, home, run, ['--platform', 'web', '--llm', 'claude-code'])

    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]!.args).toEqual(['install'])
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
    expect(run.calls).toHaveLength(1)
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
    expect(run.calls).toHaveLength(1)
  })
})

function failing(code: number | null, output: string, extra: { missing?: boolean } = {}) {
  return fakeRunner(() => ({ code, signal: null, output, ...extra }))
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

  it('a manager that is not found is a failed step with the command to run', async () => {
    const { root, home } = tempProject('install-missing-manager')

    const error = await refusal(init(root, home, failing(null, '', { missing: true })))

    expect(error.exitCode).toBe(3)
    expect(stdout()).toContain('✗ Install failed: npm was not found')
    expect(stdout()).toContain('  Run: npm install')
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
