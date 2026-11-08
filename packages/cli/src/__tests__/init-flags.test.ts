import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

vi.mock('@inquirer/select', () => ({ default: vi.fn(async () => 'gemini') }))
vi.mock('@inquirer/input', () => ({ default: vi.fn(async () => 'gemini-model') }))

import input from '@inquirer/input'
import select from '@inquirer/select'

import { createInitCommand } from '../commands/init.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import { cleanupTempProjects, fakeRunner, tempProject } from './project-fixtures.js'

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-flags', runtimeContext: 'user' }),
  })

async function initInATerminal(args: readonly string[], ui: FakeInitUi): Promise<string> {
  const { root, home } = tempProject('init-flags')
  const parent = new Command()
  const command = createInitCommand({
    cwd: root,
    host: { homedir: home, env: {}, run: fakeRunner() },
    isTTY: true,
    composeAnalytics: silentAnalytics,
    ui,
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  await parent.parseAsync(['node', 'test', 'init', ...args, '--pm', 'none'])
  return root
}

function questions(ui: FakeInitUi): string[] {
  return ui.entries
    .filter((entry) => ['select', 'multiselect', 'text'].includes(entry.kind))
    .map((entry) => entry.text)
}

function promptsAsked(): number {
  return [select, input].reduce(
    (sum, prompt) => sum + vi.mocked(prompt).mock.calls.length,
    0,
  )
}

function configuredLlm(root: string): unknown {
  const config = parseYaml(readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8')) as {
    registry: { llms: unknown[] }
  }
  return config.registry.llms[0]
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  cleanupTempProjects()
})

describe('init --help', () => {
  it('lists --yes and --json and no --write-agent-instructions', () => {
    const help = createInitCommand().helpInformation()

    expect(help).toContain('--yes')
    expect(help).toContain('--json')
    expect(help).not.toContain('--write-agent-instructions')
  })
})

describe('init in a terminal', () => {
  it('asks its questions without --yes or --json', async () => {
    const ui = fakeInitUi()

    const root = await initInATerminal([], ui)

    expect(questions(ui)).toEqual(['What platform will you test?'])
    expect(promptsAsked()).toBeGreaterThan(0)
    expect(configuredLlm(root)).toMatchObject({ provider: 'gemini', model: 'gemini-model' })
  })

  it.each([['--yes'], ['--json']])(
    'asks nothing under %s and takes every default',
    async (flag) => {
      const ui = fakeInitUi()

      const root = await initInATerminal([flag], ui)

      expect(questions(ui)).toEqual([])
      expect(promptsAsked()).toBe(0)
      expect(configuredLlm(root)).toMatchObject({
        name: 'claude-code',
        provider: 'anthropic-subscription',
      })
    },
  )
})
