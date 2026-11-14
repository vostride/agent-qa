import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getAuthPath } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InitDocument } from '../commands/init-document.js'
import type { RunResult } from '../commands/project-host.js'
import { SETUP_MENU_QUESTION } from '../commands/init-rerun.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import { cleanupTempProjects, fakeRunner, type FakeRunner } from './project-fixtures.js'
import { initializedProject, rerun, type RerunOptions } from './rerun-fixtures.js'

const { PROJECT_VERSION } = vi.hoisted(() => ({ PROJECT_VERSION: '0.3.0' }))

vi.mock('@vostride/agent-qa-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-core')>()),
  getAgentQaVersion: () => PROJECT_VERSION,
}))

const NODE = '/fake/node'
const OK: RunResult = { code: 0, signal: null, output: '' }
const GUIDE_LINE = 'agent-qa 0.4.0 can change your config. To upgrade, point your coding agent at'
const GUIDE_0_3_TO_0_4 = 'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4'
const DASHBOARD = 'npx agent-qa dashboard'
const MODEL_PAGE = 'npx agent-qa dashboard --open "/config/models"'
const RUN_STARTER = 'npx agent-qa run tests/examples/komazon-cart-total.yaml'

afterEach(() => {
  cleanupTempProjects()
})

function saveGeminiKey(home: string): void {
  const authPath = getAuthPath({ env: {}, homeDir: home })
  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(
    authPath,
    JSON.stringify({ gemini: { type: 'api', provider: 'gemini', key: 'DUMMY-KEY-ENDING' } }),
  )
}

function nextSteps(entries: readonly FakeInitUiEntry[]): string[] {
  const note = entries.find((entry) => entry.kind === 'note' && entry.text === 'Next steps')
  return note?.kind === 'note' ? note.lines : []
}

function linesAfterNextSteps(entries: readonly FakeInitUiEntry[]): string[] {
  const at = entries.findIndex((entry) => entry.kind === 'note' && entry.text === 'Next steps')
  return entries
    .slice(at + 1)
    .filter((entry) => entry.kind === 'line')
    .map((entry) => entry.text)
}

function dashboardCalls(run: FakeRunner): string[][] {
  return run.calls.filter((call) => call.args.includes('dashboard')).map((call) => [...call.args])
}

function recordingRunner(): FakeRunner {
  return fakeRunner(({ args }) =>
    args.length === 1 && args[0] === '--version' ? { ...OK, output: '11.0.0\n' } : OK,
  )
}

function interactive(run: FakeRunner, extra: RerunOptions = {}): RerunOptions {
  return {
    run,
    ...extra,
    hooks: { isTTY: true, ...extra.hooks },
  }
}

describe('a re-run ends with validate and the next steps', () => {
  it('records validate after the rows and draws the next steps box after it', async () => {
    const project = await initializedProject('ending-validate-then-next-steps')

    const result = await rerun(project, ['--yes'])

    expect(result.exit, result.stderr).toBe(0)
    const validated = result.entries.findIndex(
      (entry) => entry.kind === 'done' && entry.text === 'validate: the config and tests are valid',
    )
    const note = result.entries.findIndex(
      (entry) => entry.kind === 'note' && entry.text === 'Next steps',
    )
    expect(validated).toBeGreaterThanOrEqual(0)
    expect(note).toBeGreaterThan(validated)
    expect(nextSteps(result.entries)).toEqual([
      'Finish setting up the model in the dashboard:',
      MODEL_PAGE,
      '',
      'Run a test in the dashboard:',
      DASHBOARD,
      '',
      'Run a test from the terminal:',
      RUN_STARTER,
    ])
  })

  it('a project without the starter file gets no terminal group, the file stays absent and the scaffold row is named', async () => {
    const project = await initializedProject('ending-starter-deleted')
    const starter = join(project.root, 'tests', 'examples', 'komazon-cart-total.yaml')
    rmSync(starter)

    const result = await rerun(project, ['--yes'])

    expect(result.exit, result.stderr).toBe(0)
    expect(nextSteps(result.entries)).toEqual([
      'npx agent-qa init --setup scaffold',
      '',
      'Finish setting up the model in the dashboard:',
      MODEL_PAGE,
      '',
      'Run a test in the dashboard:',
      DASHBOARD,
    ])
    expect(existsSync(starter)).toBe(false)
  })

  it('puts the --json document steps in order, ending at validate', async () => {
    const project = await initializedProject('ending-json-steps')

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps.at(-1)?.name).toBe('validate')
    expect(doc.steps.some((step) => (step.name as string) === 'dashboard')).toBe(false)
    expect(doc.nextSteps).toEqual([
      { command: MODEL_PAGE, description: 'Finish setting up the model in the dashboard:' },
      { command: DASHBOARD, description: 'Run a test in the dashboard:' },
      { command: RUN_STARTER, description: 'Run a test from the terminal:' },
    ])
  })

  it("lists a failed row's command first, then npx agent-qa init --setup for a row left unchecked", async () => {
    const project = await initializedProject('ending-failed-then-unchecked')
    rmSync(join(project.root, 'node_modules', 'agent-qa'), { recursive: true, force: true })
    writeFileSync(join(project.root, '.gitignore'), 'dist/\n')
    const run = fakeRunner(({ command, args }) => {
      if (args.length === 1 && args[0] === '--version') return { ...OK, output: '11.0.0\n' }
      if (command === NODE) return OK
      return { code: 1, signal: null, output: 'npm error network\n' }
    })

    const result = await rerun(project, ['--setup', 'deps', '--json'], { run, plain: true })

    expect(result.exit, result.stderr).toBe(3)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({
      name: 'gitignore',
      outcome: 'skipped',
      reason: 'not selected',
      command: 'npx agent-qa init --setup gitignore',
    })
    expect(doc.nextSteps.slice(0, 2)).toEqual([
      { command: 'npm install', description: "Install agent-qa's missing packages" },
      {
        command: 'npx agent-qa init --setup gitignore',
        description: "Restore init's .gitignore block",
      },
    ])
  })

  it('gives a row left unchecked in the menu its --setup line, and a current row none', async () => {
    const project = await initializedProject('ending-menu-unchecked')
    writeFileSync(join(project.root, '.gitignore'), 'dist/\n')

    const result = await rerun(project, [], {
      hooks: { isTTY: true },
      answers: { [SETUP_MENU_QUESTION]: [] },
    })

    expect(result.exit, result.stderr).toBe(0)
    const lines = nextSteps(result.entries)
    expect(lines).toContain('npx agent-qa init --setup gitignore')
    expect(lines.filter((line) => line.startsWith('npx agent-qa init --setup'))).toEqual([
      'npx agent-qa init --setup gitignore',
    ])
  })

  it('carries the migration guide line and its URL under the next steps for a breaking move', async () => {
    const project = await initializedProject('ending-breaking-guide')

    const result = await rerun(project, ['--setup', 'none'], {
      hooks: { latestVersion: async () => ({ source: 'registry', latestVersion: '0.4.0' }) },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(nextSteps(result.entries)[0]).toBe('npx agent-qa init --setup upgrade')
    expect(linesAfterNextSteps(result.entries).slice(0, 2)).toEqual([GUIDE_LINE, GUIDE_0_3_TO_0_4])
  })

  it('adds no guide line for a patch move', async () => {
    const project = await initializedProject('ending-patch-no-guide')

    const result = await rerun(project, ['--setup', 'none'], {
      hooks: { latestVersion: async () => ({ source: 'registry', latestVersion: '0.3.2' }) },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(nextSteps(result.entries)[0]).toBe('npx agent-qa init --setup upgrade')
    expect(linesAfterNextSteps(result.entries).join('\n')).not.toContain('can change your config')
  })
})

describe('an interactive re-run ends on its next steps and starts nothing', () => {
  it('lists the model page and the dashboard while the model is pending, and runs no dashboard', async () => {
    const project = await initializedProject('ending-pending-model')
    const run = recordingRunner()

    const result = await rerun(project, [], interactive(run))

    expect(result.exit, result.stderr).toBe(0)
    expect(dashboardCalls(run)).toEqual([])
    expect(nextSteps(result.entries)).toContain(MODEL_PAGE)
    expect(nextSteps(result.entries)).toContain(DASHBOARD)
    expect(result.entries.at(-1)?.kind).toBe('outro')
    expect(result.entries.some((entry) => entry.text.startsWith('Dashboard'))).toBe(false)
  })

  it('lists the sign-in of a pending subscription and not the model page', async () => {
    const project = await initializedProject('ending-pending-subscription', { llm: 'claude-code' })

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.nextSteps).toContainEqual({
      command: 'npx agent-qa auth login --config claude-code',
      description: 'Sign in with your subscription:',
    })
    expect(doc.nextSteps.some((step) => step.command.includes('--open'))).toBe(false)
  })

  it('lists the dashboard and no model page once the model is ready, and runs no dashboard', async () => {
    const project = await initializedProject('ending-ready-model')
    saveGeminiKey(project.home)
    const run = recordingRunner()

    const result = await rerun(project, [], interactive(run))

    expect(result.exit, result.stderr).toBe(0)
    expect(dashboardCalls(run)).toEqual([])
    expect(nextSteps(result.entries)).toContain(DASHBOARD)
    expect(nextSteps(result.entries).some((line) => line.includes('--open'))).toBe(false)
  })
})
