import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getAuthPath } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import { installedAgentQaVersion } from '../commands/package-json-plan.js'
import type { RunResult } from '../commands/project-host.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from '../commands/scaffold-content.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
} from './project-fixtures.js'

const BASE = ['--platform', 'web', '--no-browsers', '--agents', 'none', '--pm', 'npm']
const OK: RunResult = { code: 0, signal: null, output: '' }
const DASHBOARD = 'npx agent-qa dashboard'
const IN_THE_DASHBOARD = 'Run a test in the dashboard:'
const FROM_THE_TERMINAL = 'Run a test from the terminal:'
const RUN_STARTER = 'npx agent-qa run tests/examples/komazon-cart-total.yaml'
const MODEL_PAGE = 'npx agent-qa dashboard --open "/config/models"'

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-next-steps', runtimeContext: 'user' }),
  })

let stderr: MockInstance<typeof process.stderr.write>
let stdout: MockInstance<typeof process.stdout.write>

interface Project {
  root: string
  home: string
}

function project(): Project {
  const { root, home } = tempProject('next-steps')
  writeInstalledPackage(root, 'agent-qa', installedAgentQaVersion(), {
    packageJson: { bin: { 'agent-qa': 'cli.js' } },
    files: { 'cli.js': '' },
  })
  return { root, home }
}

function saveCredentials(home: string, store: Record<string, unknown>): void {
  const authPath = getAuthPath({ env: {}, homeDir: home })
  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(authPath, JSON.stringify(store))
}

// Answers the manager's version probe and passes every other call.
function runner(): FakeRunner {
  return fakeRunner(({ args }) =>
    args[0] === '--version' ? { code: 0, signal: null, output: '10.0.0\n' } : OK,
  )
}

function dashboardCalls(run: FakeRunner): string[][] {
  return run.calls
    .filter((call) => call.args.includes('dashboard'))
    .map((call) => [call.command, ...call.args])
}

interface InitExit {
  exit: number | undefined
  stderr: string
}

async function init(
  { root, home }: Project,
  args: readonly string[],
  options: { run: FakeRunner; ui?: FakeInitUi; isTTY?: boolean },
): Promise<InitExit> {
  stderr.mockClear()
  stdout.mockClear()
  const program = new Command('agent-qa').addCommand(
    createInitCommand({
      cwd: root,
      host: { homedir: home, env: {}, run: options.run },
      isTTY: options.isTTY ?? true,
      ...(options.ui === undefined ? {} : { ui: options.ui }),
      composeAnalytics: silentAnalytics,
    }),
  )
  const printed: string[] = []
  let exit: number | undefined
  const deps: CliFailureDeps = {
    print: (text) => printed.push(text),
    printFixed: (line) => printed.push(line),
    mask: (text) => text,
    setExitCode: () => {},
    capture: () => {},
    settle: async () => {},
    flush: async () => {},
    exit: (code) => {
      exit = code
    },
    env: {},
  }
  await runCli(program, ['node', 'agent-qa', 'init', ...args], deps)
  const written = stderr.mock.calls.map((call) => String(call[0])).join('')
  return { exit, stderr: `${written}${printed.join('\n')}` }
}

function nextSteps(ui: FakeInitUi): string[] {
  const note = ui.entries.find((entry) => entry.kind === 'note' && entry.text === 'Next steps')
  return note?.kind === 'note' ? note.lines : []
}

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempProjects()
})

describe('an interactive fresh init ends on its next steps and starts nothing', () => {
  it('draws the next steps, then the outro, and runs no dashboard', async () => {
    const ui = fakeInitUi()
    const run = runner()

    const result = await init(project(), [...BASE, '--llm', 'gemini'], { run, ui })

    expect(result.exit, result.stderr).toBeUndefined()
    expect(dashboardCalls(run)).toEqual([])
    const note = ui.entries.findIndex(
      (entry) => entry.kind === 'note' && entry.text === 'Next steps',
    )
    expect(note).toBeGreaterThanOrEqual(0)
    expect(ui.entries.at(-1)?.kind).toBe('outro')
    expect(ui.entries.slice(note).some((entry) => entry.text.startsWith('Dashboard'))).toBe(false)
    expect(nextSteps(ui).slice(-8)).toEqual([
      'Finish setting up the model in the dashboard:',
      MODEL_PAGE,
      '',
      IN_THE_DASHBOARD,
      DASHBOARD,
      '',
      FROM_THE_TERMINAL,
      RUN_STARTER,
    ])
  })

  it('a pending Claude subscription asks its three questions, signs nothing in and lists the sign-in line and the model page', async () => {
    const target = project()
    writeInstalledPackage(target.root, SUBSCRIPTION_AUTH_PACKAGE, installedAgentQaVersion())
    const ui = fakeInitUi({ 'Which coding agents should agent-qa set up?': [] })
    const run = runner()

    const result = await init(target, ['--no-browsers', '--pm', 'npm'], { run, ui })

    expect(result.exit, result.stderr).toBeUndefined()
    expect(
      ui.entries
        .filter((entry) => entry.kind === 'select' || entry.kind === 'multiselect')
        .map((entry) => ({ kind: entry.kind, text: entry.text, answer: entry.answer })),
    ).toEqual([
      { kind: 'multiselect', text: 'What platform will you test?', answer: ['web'] },
      { kind: 'select', text: 'Which model should agent-qa use?', answer: expect.anything() },
      { kind: 'multiselect', text: 'Which coding agents should agent-qa set up?', answer: [] },
    ])
    expect(ui.output()).not.toMatch(/sign(ed|ing)?[ -]in/iu)
    expect(dashboardCalls(run)).toEqual([])
    expect(nextSteps(ui)).toContain('npx agent-qa auth login --config claude-code')
    expect(nextSteps(ui)).toContain(MODEL_PAGE)
  })

  it('a saved compatible key lists the model page with its name', async () => {
    const target = project()
    saveCredentials(target.home, {
      work: { type: 'api', provider: 'openai-compatible', key: 'DUMMY-KEY-W' },
    })
    const ui = fakeInitUi()
    const run = runner()

    await init(target, [...BASE, '--llm', 'work'], { run, ui })

    expect(dashboardCalls(run)).toEqual([])
    expect(nextSteps(ui)).toContain(
      'npx agent-qa dashboard --open "/config/models?add=openai-compatible-key&name=work"',
    )
    expect(nextSteps(ui)).toContain('Add the model in the dashboard:')
  })

  it('a new Anthropic-compatible endpoint lists the model page by its kind', async () => {
    const ui = fakeInitUi()
    const run = runner()

    await init(project(), [...BASE, '--llm', 'anthropic-compatible'], { run, ui })

    expect(dashboardCalls(run)).toEqual([])
    expect(nextSteps(ui)).toContain(
      'npx agent-qa dashboard --open "/config/models?add=anthropic-compatible-key"',
    )
  })

  it('a ready model lists the dashboard and no model page', async () => {
    const target = project()
    saveCredentials(target.home, {
      gemini: { type: 'api', provider: 'gemini', key: 'DUMMY-KEY-D' },
    })
    const ui = fakeInitUi()
    const run = runner()

    await init(target, [...BASE, '--llm', 'gemini'], { run, ui })

    expect(dashboardCalls(run)).toEqual([])
    expect(nextSteps(ui)).toContain(DASHBOARD)
    expect(nextSteps(ui).some((line) => line.includes('--open'))).toBe(false)
  })
})

describe('a fresh init without a terminal', () => {
  it('prints the box on stderr with truly empty lines between the groups, and runs no dashboard', async () => {
    const run = runner()

    const result = await init(project(), [...BASE, '--llm', 'gemini'], { run, isTTY: false })

    expect(result.exit, result.stderr).toBeUndefined()
    expect(dashboardCalls(run)).toEqual([])
    expect(result.stderr).toContain(
      [
        '  Finish setting up the model in the dashboard:',
        `  ${MODEL_PAGE}`,
        '',
        `  ${IN_THE_DASHBOARD}`,
        `  ${DASHBOARD}`,
        '',
        `  ${FROM_THE_TERMINAL}`,
        `  ${RUN_STARTER}`,
        '',
      ].join('\n'),
    )
    expect(result.stderr.split('\n')).not.toContain('  ')
    expect(result.stderr).not.toMatch(/^.*Dashboard: /mu)
  })
})
