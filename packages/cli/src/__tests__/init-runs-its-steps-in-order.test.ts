import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { createInitCommand } from '../commands/init.js'
import { InitRefusal } from '../commands/init-refusal.js'
import { createInitStepRunner, type InitStepName } from '../commands/init-steps.js'
import { installedAgentQaVersion, sanitizedPackageName } from '../commands/package-json-plan.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  skillFolderFiles,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
} from './project-fixtures.js'

const PLAN: readonly InitStepName[] = ['package-json', 'scaffold', 'install']
const CHROMIUM_COMMAND = 'npx agent-qa install-browsers --chromium'

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-steps', runtimeContext: 'user' }),
  })

let stderr: MockInstance<typeof process.stderr.write>
let stdout: MockInstance<typeof process.stdout.write>
let log: MockInstance<typeof console.log>

function written(spy: MockInstance<(chunk: never) => boolean>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

async function init(
  cwd: string,
  home: string,
  options: { args?: readonly string[]; ui?: FakeInitUi; run?: FakeRunner; isTTY?: boolean } = {},
): Promise<void> {
  const parent = new Command()
  const command = createInitCommand({
    cwd,
    host: { homedir: home, env: {}, run: options.run ?? fakeRunner() },
    isTTY: options.isTTY ?? false,
    composeAnalytics: silentAnalytics,
    ...(options.ui === undefined ? {} : { ui: options.ui }),
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  await parent.parseAsync([
    'node',
    'test',
    'init',
    ...(options.args ?? ['--platform', 'web', '--llm', 'gemini', '--pm', 'none']),
  ])
}

function sigintListeners(): ((...args: unknown[]) => void)[] {
  return process.listeners('SIGINT') as ((...args: unknown[]) => void)[]
}

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempProjects()
})

describe('a fresh init draws one line per step', () => {
  it('writes the What to expect line, then the package.json, scaffold, install and Chromium lines to stderr in order and nothing to stdout', async () => {
    const { root, home } = tempProject('steps-plain')

    await init(root, home)

    const lines = written(stderr).split('\n')
    const name = sanitizedPackageName(basename(root))
    const packageJson = lines.indexOf(`✓ package.json created (${name})`)
    const scaffold = lines.findIndex((line) =>
      /^✓ Scaffold: config, 3 example tests and a suite \(\d+ files\)$/u.test(line),
    )
    const install = lines.findIndex((line) => line.startsWith('– Declared agent-qa '))
    const chromium = lines.indexOf('✓ Chromium installed')
    expect(lines[0]).toMatch(/^3 questions, then: package\.json, scaffold, install/u)
    expect(packageJson).toBe(1)
    expect(scaffold).toBe(2)
    expect(install).toBe(3)
    expect(chromium).toBe(4)
    expect(lines[install]).toContain('Install with: npm install')
    expect(written(stdout)).toBe('')
    expect(log).not.toHaveBeenCalled()
  })

  it('the scaffold line counts the files the scaffold wrote', async () => {
    const { root, home } = tempProject('steps-count')
    const ui = fakeInitUi()

    await init(root, home, { ui })

    const scaffold = ui.entries.find(
      (entry) => entry.kind === 'done' && entry.text.startsWith('Scaffold:'),
    )
    expect(scaffold?.text).toBe('Scaffold: config, 3 example tests and a suite (13 files)')
  })

  it('a mobile scaffold names only the config', async () => {
    const { root, home } = tempProject('steps-mobile')
    const ui = fakeInitUi()

    const args = ['--platform', 'android', '--llm', 'gemini', '--pm', 'none']
    await init(root, home, { ui, args })

    expect(ui.entries).toContainEqual({ kind: 'done', text: 'Scaffold: config (8 files)' })
  })

  it('draws its titled steps through the seam and lists no files', async () => {
    const { root, home } = tempProject('steps-fake')
    const ui = fakeInitUi()

    await init(root, home, { ui })

    expect(ui.entries.filter((entry) => entry.kind === 'step').map((entry) => entry.text)).toEqual([
      'Writing package.json',
      'Writing the scaffold',
      'Installing dependencies',
      'Installing Chromium',
      'Setting up the coding agents',
      'validate: install first (--pm none)',
      'Sign-in: skipped (not a subscription model)',
      'Dashboard: skipped (not interactive)',
    ])
    expect(ui.output()).not.toContain('tests/examples/komazon-checkout.yaml')
    expect(ui.output()).not.toContain('agent-qa-knowledge/README.md')
    expect(written(stderr)).toBe('')
  })

  it('an existing package.json reads as updated, and an unchanged one as kept', async () => {
    const { root, home } = tempProject('steps-updated')
    writeFileSync(join(root, 'package.json'), '{\n  "name": "mine"\n}\n')
    const first = fakeInitUi()

    await init(root, home, { ui: first })

    expect(first.entries).toContainEqual({ kind: 'done', text: 'package.json updated' })
    const second = fakeInitUi()
    await init(root, home, {
      ui: second,
      args: ['--platform', 'web', '--llm', 'gemini', '--pm', 'none', '--force'],
    })
    expect(second.entries).toContainEqual({ kind: 'done', text: 'package.json kept' })
  })

  it('a failed install is drawn with its command, and init exits 3 after the other steps ran', async () => {
    const { root, home } = tempProject('steps-failed-install')
    const ui = fakeInitUi()
    const run = fakeRunner(({ args }) =>
      args[0] === '--version'
        ? { code: 0, signal: null, output: '10.0.0\n' }
        : { code: 1, signal: null, output: 'npm ERR! boom\n' },
    )

    const error = await init(root, home, {
      ui,
      run,
      args: ['--platform', 'web', '--llm', 'gemini'],
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CliRefusal)
    expect(error).toMatchObject({ exitCode: 3 })
    expect(ui.entries.filter((entry) => entry.kind === 'done').map((entry) => entry.text)).toEqual([
      `package.json created (${sanitizedPackageName(basename(root))})`,
      'Scaffold: config, 3 example tests and a suite (13 files)',
      expect.stringMatching(/^Claude Code and Codex: \d+ skills, MCP entries, AGENTS\.md block/u),
    ])
    expect(ui.entries).toContainEqual({
      kind: 'failed',
      text: 'Install failed: npm exited 1\n  npm ERR! boom',
      command: 'npm install',
    })
    expect(ui.output()).toContain(
      '✗ Install failed: npm exited 1\n  npm ERR! boom\n  Run: npm install\n',
    )
    expect(readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8')).toContain('registry:')
  })

  it('a package.json that is not written skips the scaffold and the install, and init exits 3', async () => {
    const { root, home } = tempProject('steps-no-package-json')
    const ui = fakeInitUi()
    const run = fakeRunner()
    const parent = new Command()
    const command = createInitCommand({
      cwd: root,
      host: { homedir: home, env: {}, run },
      isTTY: false,
      composeAnalytics: silentAnalytics,
      ui,
      afterWrite: (result) => {
        if (result.path.endsWith('package.json')) throw new Error('EACCES: permission denied')
      },
    })
    parent.exitOverride()
    command.exitOverride()
    parent.addCommand(command)

    const error = await parent
      .parseAsync(['node', 'test', 'init', '--platform', 'web', '--llm', 'gemini'])
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'CliRefusal', exitCode: 3 })
    expect(ui.output()).toContain(
      '✗ EACCES: permission denied\n' +
        '– Scaffold: skipped (package.json was not written)\n' +
        '– Install: skipped (package.json was not written)\n' +
        '– Chromium: skipped (package.json was not written)\n' +
        '– Coding agents: skipped (package.json was not written)\n' +
        '– validate: skipped (package.json was not written)\n',
    )
    expect(run.calls).toEqual([])
    expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(false)
  })

  it('an interactive init that wrote no config skips the dashboard and lists init as the next step', async () => {
    const { root, home } = tempProject('steps-no-config-no-dashboard')
    const ui = fakeInitUi()
    const run = fakeRunner()
    const parent = new Command()
    const command = createInitCommand({
      cwd: root,
      host: { homedir: home, env: {}, run },
      isTTY: true,
      composeAnalytics: silentAnalytics,
      ui,
      dashboardPort: {
        probe: async () => {
          throw new Error('the port was probed')
        },
        findFree: async () => 0,
      },
      afterWrite: (result) => {
        if (result.path.endsWith('package.json')) throw new Error('EACCES: permission denied')
      },
    })
    parent.exitOverride()
    command.exitOverride()
    parent.addCommand(command)

    const error = await parent
      .parseAsync(['node', 'test', 'init', '--platform', 'web', '--llm', 'gemini'])
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'CliRefusal', exitCode: 3 })
    expect(ui.entries).toContainEqual({
      kind: 'skipped',
      text: 'Dashboard: skipped (no config was written)',
    })
    expect(ui.entries.find((entry) => entry.kind === 'note')).toMatchObject({
      text: 'Next steps',
      lines: ['npx agent-qa init'],
    })
    expect(run.calls).toEqual([])
  })

  it('a Chromium download that fails twice is failed with its last line and command, and init exits 3', async () => {
    const { root, home } = tempProject('steps-chromium-failed')
    const ui = fakeInitUi()
    const run = fakeRunner(({ args }) =>
      args.includes('install-browsers')
        ? { code: 1, signal: null, output: 'Downloading Chromium\nError: connect ECONNREFUSED\n' }
        : { code: 0, signal: null, output: '' },
    )

    const error = await init(root, home, { ui, run }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'CliRefusal', exitCode: 3 })
    expect(run.calls.filter((call) => call.args.includes('install-browsers'))).toHaveLength(2)
    expect(ui.entries).toContainEqual({
      kind: 'failed',
      text: 'Chromium download failed twice: Error: connect ECONNREFUSED',
      command: CHROMIUM_COMMAND,
    })
  })

  it('a Chromium download that fails once and then succeeds is done after two calls', async () => {
    const { root, home } = tempProject('steps-chromium-retry')
    const ui = fakeInitUi()
    let attempts = 0
    const run = fakeRunner(({ args }) => {
      if (!args.includes('install-browsers')) return { code: 0, signal: null, output: '' }
      attempts += 1
      return { code: attempts === 1 ? 1 : 0, signal: null, output: '' }
    })

    await init(root, home, { ui, run })

    expect(run.calls.filter((call) => call.args.includes('install-browsers'))).toHaveLength(2)
    expect(ui.entries).toContainEqual({ kind: 'done', text: 'Chromium installed' })
    expect(ui.entries.some((entry) => entry.kind === 'failed')).toBe(false)
  })

  it('a malformed managed block in .gitignore still ends init with exit 2', async () => {
    const { root, home } = tempProject('steps-refusal')
    writeFileSync(join(root, '.gitignore'), '# agent-qa init:start\nnode_modules/\n')
    const ui = fakeInitUi()

    const error = await init(root, home, { ui }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CliRefusal)
    expect(error).toMatchObject({ exitCode: 2 })
    expect(ui.entries.some((entry) => entry.kind === 'failed')).toBe(false)
  })

  it('an unsafe agent-qa-knowledge/.gitignore is refused with exit 2 before any question', async () => {
    const { root, home } = tempProject('steps-knowledge-gitignore')
    rmSync(join(root, '.git'), { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' })
    mkdirSync(join(root, 'agent-qa-knowledge'))
    writeFileSync(join(root, 'agent-qa-knowledge', '.gitignore'), '# mine\n')
    const ui = fakeInitUi()

    const error = await init(root, home, { ui, isTTY: true, args: [] }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(CliRefusal)
    expect(error).toMatchObject({ exitCode: 2 })
    expect(String((error as CliRefusal).message)).toContain(
      'existing agent-qa-knowledge/.gitignore is unsafe',
    )
    expect(ui.entries.map((entry) => entry.kind)).toEqual([])
    expect(existsSync(join(root, 'package.json'))).toBe(false)
    expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(false)
  })

  it('a malformed package.json is refused with exit 2 before any step', async () => {
    const { root, home } = tempProject('steps-bad-package-json')
    writeFileSync(join(root, 'package.json'), '{ not json')
    const ui = fakeInitUi()

    const error = await init(root, home, { ui }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ exitCode: 2 })
    expect(ui.entries.filter((entry) => entry.kind === 'step')).toEqual([])
  })
})

function installAgentQaWithTwoSkills(root: string): void {
  writeInstalledPackage(root, 'agent-qa', installedAgentQaVersion(), {
    packageJson: { bin: { 'agent-qa': 'cli.js' } },
    files: {
      'cli.js': '',
      ...skillFolderFiles('agent-qa-alpha'),
      ...skillFolderFiles('agent-qa-beta'),
    },
  })
}

function stepLines(ui: FakeInitUi): string[] {
  return ui.entries
    .filter((entry) => ['done', 'skipped', 'failed'].includes(entry.kind))
    .map((entry) => entry.text)
}

// The project's agent-qa is in node_modules already, so the fake npm run leaves it installed.
const CLAUDE_CODE = [
  '--platform',
  'web',
  '--llm',
  'gemini',
  '--pm',
  'npm',
  '--agents',
  'claude-code',
]
const CLAUDE_CODE_DECLARED = CLAUDE_CODE.map((arg) => (arg === 'npm' ? 'none' : arg))

function agentQaCalls(run: FakeRunner): string[][] {
  return run.calls.filter((call) => call.command === process.execPath).map((call) => call.args)
}

describe('the steps after the install', () => {
  it('Chromium, the coding agents and validate follow the install, one line each', async () => {
    const { root, home } = tempProject('steps-after-install')
    installAgentQaWithTwoSkills(root)
    const ui = fakeInitUi()
    const run = fakeRunner()

    await init(root, home, { ui, run, args: CLAUDE_CODE })

    const lines = stepLines(ui)
    expect(lines.slice(3)).toEqual([
      'Chromium installed',
      'Claude Code: 2 skills, MCP entries, AGENTS.md block',
      'validate: the config and tests are valid',
      'Sign-in: skipped (not a subscription model)',
      'Dashboard: skipped (not interactive)',
    ])
    expect(lines[0]).toMatch(/^package\.json created/u)
    expect(lines[1]).toMatch(/^Scaffold:/u)
    expect(lines[2]).toMatch(/^Installed agent-qa /u)
    const copyBin = join(realpathSync(root), 'node_modules', 'agent-qa', 'cli.js')
    expect(agentQaCalls(run)).toEqual([
      [copyBin, 'install-browsers', '--chromium'],
      [copyBin, 'validate'],
    ])
    expect(existsSync(join(root, '.claude', 'skills', 'agent-qa-alpha', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, '.mcp.json'))).toBe(true)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('<!-- agent-qa init:start -->')
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(root, 'agent-qa-knowledge', 'CLAUDE.md'))).toBe(false)
  })

  it("a person's CLAUDE.md keeps its bytes while AGENTS.md gains the block", async () => {
    const { root, home } = tempProject('steps-own-claude')
    installAgentQaWithTwoSkills(root)
    const mine = Buffer.from('# House rules\r\n\nno final newline', 'utf8')
    writeFileSync(join(root, 'CLAUDE.md'), mine)

    await init(root, home, { ui: fakeInitUi(), run: fakeRunner(), args: CLAUDE_CODE })

    expect(readFileSync(join(root, 'CLAUDE.md')).equals(mine)).toBe(true)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('<!-- agent-qa init:start -->')
    expect(existsSync(join(root, 'agent-qa-knowledge', 'CLAUDE.md'))).toBe(false)
  })

  it('a Chromium step that fails twice still lets the coding agents and validate run, and init exits 3', async () => {
    const { root, home } = tempProject('steps-after-failed-chromium')
    installAgentQaWithTwoSkills(root)
    const ui = fakeInitUi()
    const run = fakeRunner(({ args }) => ({
      code: args.includes('install-browsers') ? 1 : 0,
      signal: null,
      output: '',
    }))

    const error = await init(root, home, { ui, run, args: CLAUDE_CODE }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toMatchObject({ name: 'CliRefusal', exitCode: 3 })
    expect(stepLines(ui).slice(3)).toEqual([
      'Chromium download failed twice',
      'Claude Code: 2 skills, MCP entries, AGENTS.md block',
      'validate: the config and tests are valid',
      'Sign-in: skipped (not a subscription model)',
      'Dashboard: skipped (not interactive)',
    ])
  })

  it('--agents none skips the coding agents and writes none of their files', async () => {
    const { root, home } = tempProject('steps-no-agents')
    installAgentQaWithTwoSkills(root)
    const ui = fakeInitUi()

    const args = ['--platform', 'web', '--llm', 'gemini', '--pm', 'none', '--agents', 'none']
    await init(root, home, { ui, run: fakeRunner(), args })

    expect(ui.entries).toContainEqual({ kind: 'skipped', text: 'Coding agents: none chosen' })
    for (const path of ['.claude', '.agents', '.mcp.json', '.codex', 'AGENTS.md']) {
      expect(existsSync(join(root, path)), path).toBe(false)
    }
  })

  it('with no agent-qa installed, the skills line says they came from this agent-qa', async () => {
    const { root, home } = tempProject('steps-running-skills')
    const ui = fakeInitUi()

    await init(root, home, { ui, run: fakeRunner(), args: CLAUDE_CODE_DECLARED })

    const version = installedAgentQaVersion()
    expect(stepLines(ui)).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Claude Code: \\d+ skills, MCP entries, AGENTS\\.md block \\(from this agent-qa ` +
            `${version.replaceAll('.', '\\.')}; the project has none installed\\)$`,
          'u',
        ),
      ),
    )
  })

  it('a validate that exits 1 is failed with its first error line and the validate command', async () => {
    const { root, home } = tempProject('steps-validate-failed')
    installAgentQaWithTwoSkills(root)
    const ui = fakeInitUi()
    const run = fakeRunner(({ args }) =>
      args.includes('validate')
        ? {
            code: 1,
            signal: null,
            output: `${join(root, 'agent-qa.config.yaml')}\n  3:5  error  use.llm names no model\n`,
          }
        : { code: 0, signal: null, output: '' },
    )

    const error = await init(root, home, { ui, run, args: CLAUDE_CODE }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toMatchObject({ name: 'CliRefusal', exitCode: 3 })
    expect(ui.entries).toContainEqual({
      kind: 'failed',
      text: 'use.llm names no model',
      command: 'npx agent-qa validate',
    })
  })
})

describe('the step runner', () => {
  const signals = () => {
    const listeners = new Set<() => void>()
    return {
      on: (_event: 'SIGINT', listener: () => void) => listeners.add(listener),
      off: (_event: 'SIGINT', listener: () => void) => listeners.delete(listener),
      listeners,
    }
  }

  it('records a skipped step with its reason and draws it dimmed', async () => {
    const ui = fakeInitUi()
    const runner = createInitStepRunner({ ui, plan: PLAN, signals: signals() })

    const record = await runner.run('package-json', { title: 'package.json' }, async () => ({
      outcome: 'skipped',
      text: 'package.json: nothing to do',
      reason: 'already there',
    }))
    runner.dispose()

    expect(record).toEqual({ name: 'package-json', outcome: 'skipped', reason: 'already there' })
    expect(ui.output()).toBe('– package.json: nothing to do\n')
    expect(runner.failed()).toBe(false)
  })

  it('draws a failed step with its command, and the next step still runs', async () => {
    const ui = fakeInitUi()
    const runner = createInitStepRunner({ ui, plan: PLAN, signals: signals() })

    await runner.run('package-json', { title: 'package.json' }, async () => ({
      outcome: 'failed',
      reason: 'package.json is read-only',
      command: 'chmod u+w package.json',
    }))
    await runner.run('scaffold', { title: 'scaffold' }, async () => ({
      outcome: 'done',
      text: 'Scaffold: config (8 files)',
    }))
    runner.dispose()

    expect(ui.output()).toBe(
      '✗ package.json is read-only\n' +
        '  Run: chmod u+w package.json\n' +
        '✓ Scaffold: config (8 files)\n',
    )
    expect(runner.records()).toEqual([
      {
        name: 'package-json',
        outcome: 'failed',
        reason: 'package.json is read-only',
        command: 'chmod u+w package.json',
      },
      { name: 'scaffold', outcome: 'done' },
    ])
    expect(runner.failed()).toBe(true)
  })

  it('a step that throws is failed with the message and the step command', async () => {
    const ui = fakeInitUi()
    const runner = createInitStepRunner({ ui, plan: PLAN, signals: signals() })

    const record = await runner.run(
      'install',
      { title: 'Installing dependencies', command: 'pnpm install' },
      async () => {
        throw new Error('EACCES: permission denied')
      },
    )
    runner.dispose()

    expect(record).toEqual({
      name: 'install',
      outcome: 'failed',
      reason: 'EACCES: permission denied',
      command: 'pnpm install',
    })
    expect(ui.output()).toBe('✗ EACCES: permission denied\n  Run: pnpm install\n')
    expect(runner.failed()).toBe(true)
  })

  it.each([
    { name: 'an InitRefusal', thrown: new InitRefusal('the managed block is malformed') },
    { name: 'a CliRefusal', thrown: new CliRefusal(['package.json is not JSON'], 2) },
    {
      name: 'a TypeError',
      thrown: new TypeError("Cannot read properties of undefined (reading 'x')"),
    },
  ])(
    '$name thrown in a step passes through unchanged, is not drawn and the rest are not run',
    async ({ thrown }) => {
      const ui = fakeInitUi()
      const runner = createInitStepRunner({ ui, plan: PLAN, signals: signals() })

      await expect(
        runner.run('scaffold', { title: 'scaffold' }, async () => {
          throw thrown
        }),
      ).rejects.toBe(thrown)
      runner.dispose()

      expect(ui.entries.some((entry) => entry.kind === 'failed')).toBe(false)
      expect(runner.records()).toEqual([
        { name: 'package-json', outcome: 'skipped', reason: 'not run' },
        { name: 'scaffold', outcome: 'failed', reason: thrown.message },
        { name: 'install', outcome: 'skipped', reason: 'not run' },
      ])
    },
  )

  it('skipRemaining records only the steps not yet recorded, without drawing them', async () => {
    const ui = fakeInitUi()
    const runner = createInitStepRunner({ ui, plan: PLAN, signals: signals() })

    await runner.run('package-json', { title: 'package.json' }, async () => ({
      outcome: 'done',
      text: 'package.json kept',
    }))
    const drawn = ui.entries.length
    runner.skipRemaining('not run')
    runner.dispose()

    expect(runner.records()).toEqual([
      { name: 'package-json', outcome: 'done' },
      { name: 'scaffold', outcome: 'skipped', reason: 'not run' },
      { name: 'install', outcome: 'skipped', reason: 'not run' },
    ])
    expect(ui.entries).toHaveLength(drawn)
  })

  it('a Ctrl-C during a step fails it as interrupted, skips the rest and removes the listener', async () => {
    const before = process.listenerCount('SIGINT')
    const existing = sigintListeners()
    const ui = fakeInitUi()
    const runner = createInitStepRunner({ ui, plan: PLAN })
    const added = sigintListeners().filter((listener) => !existing.includes(listener))
    expect(added).toHaveLength(1)

    await runner.run('package-json', { title: 'package.json' }, async () => ({
      outcome: 'done',
      text: 'package.json created (app)',
    }))
    const run = runner.run('scaffold', { title: 'Writing the scaffold' }, async () => {
      added[0]!('SIGINT')
      return { outcome: 'done', text: 'Scaffold: config (8 files)' }
    })

    await expect(run).rejects.toBeInstanceOf(PromptCancelled)
    expect(runner.records()).toEqual([
      { name: 'package-json', outcome: 'done' },
      { name: 'scaffold', outcome: 'failed', reason: 'interrupted' },
      { name: 'install', outcome: 'skipped', reason: 'interrupted' },
    ])
    expect(runner.interrupted()).toBe(true)
    expect(process.listenerCount('SIGINT')).toBe(before)
    runner.dispose()
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('a Ctrl-C between steps cancels the next skip and records the rest as interrupted', async () => {
    const ui = fakeInitUi()
    const fake = signals()
    const runner = createInitStepRunner({ ui, plan: PLAN, signals: fake })

    await runner.run('package-json', { title: 'package.json' }, async () => ({
      outcome: 'done',
      text: 'package.json created (app)',
    }))
    for (const listener of fake.listeners) listener()

    expect(() => runner.skip('scaffold', 'Scaffold: skipped', 'not needed')).toThrow(
      PromptCancelled,
    )
    expect(runner.records()).toEqual([
      { name: 'package-json', outcome: 'done' },
      { name: 'scaffold', outcome: 'skipped', reason: 'interrupted' },
      { name: 'install', outcome: 'skipped', reason: 'interrupted' },
    ])
    expect(ui.entries.some((entry) => entry.text === 'Scaffold: skipped')).toBe(false)
    expect(fake.listeners.size).toBe(0)
  })

  it('a cancelled prompt inside a step is an interrupt', async () => {
    const ui = fakeInitUi()
    const fake = signals()
    const runner = createInitStepRunner({ ui, plan: PLAN, signals: fake })

    await expect(
      runner.run('package-json', { title: 'package.json' }, async () => {
        throw new PromptCancelled()
      }),
    ).rejects.toBeInstanceOf(PromptCancelled)

    expect(runner.records().map((record) => record.outcome)).toEqual([
      'failed',
      'skipped',
      'skipped',
    ])
    expect(fake.listeners.size).toBe(0)
  })

  it('removes its listener when disposed after a run that finished', async () => {
    const before = process.listenerCount('SIGINT')
    const runner = createInitStepRunner({ ui: fakeInitUi(), plan: PLAN })
    expect(process.listenerCount('SIGINT')).toBe(before + 1)

    await runner.run('package-json', { title: 'package.json' }, async () => ({
      outcome: 'done',
      text: 'package.json kept',
    }))
    runner.dispose()
    runner.dispose()

    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})
