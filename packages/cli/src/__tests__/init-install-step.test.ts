// init's install step: one plain install through an injected runner, on real temporary folders.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { createInitCommand } from '../commands/init.js'
import { runInstallStep } from '../commands/package-install.js'
import { planPackageJson, readProjectPackageJson } from '../commands/package-json-plan.js'
import { detectPackageManager } from '../commands/package-manager.js'
import { projectHost } from '../commands/project-host.js'
import { projectRange } from '../commands/project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from '../commands/scaffold-content.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
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
