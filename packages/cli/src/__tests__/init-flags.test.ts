import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { createInitCommand } from '../commands/init.js'
import type { InitDocument } from '../commands/init-document.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  type FakeRunner,
} from './project-fixtures.js'

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

function configuredLlm(root: string): unknown {
  const config = parseYaml(readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8')) as {
    registry: { llms: unknown[] }
  }
  return config.registry.llms[0]
}

let stdout: MockInstance<typeof process.stdout.write>

beforeEach(() => {
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
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
    const ui = fakeInitUi({ 'Which model should agent-qa use?': { kind: 'new', choice: 'gemini' } })

    const root = await initInATerminal([], ui)

    expect(questions(ui)).toEqual([
      'What platform will you test?',
      'Which model should agent-qa use?',
      'Which coding agents should agent-qa set up?',
    ])
    expect(configuredLlm(root)).toMatchObject({ name: 'gemini', provider: 'gemini' })
  })

  it.each([['--yes'], ['--json']])(
    'asks nothing under %s and takes every default',
    async (flag) => {
      const ui = fakeInitUi()

      const root = await initInATerminal([flag], ui)

      expect(questions(ui)).toEqual([])
      expect(configuredLlm(root)).toMatchObject({
        name: 'claude-code',
        provider: 'anthropic-subscription',
      })
    },
  )
})

async function initWithFlags(
  args: readonly string[],
): Promise<{ root: string; error: unknown; ui: FakeInitUi; run: FakeRunner }> {
  const { root, home } = tempProject('init-platform')
  const ui = fakeInitUi()
  const run = fakeRunner()
  const parent = new Command()
  const command = createInitCommand({
    cwd: root,
    host: { homedir: home, env: {}, run },
    isTTY: false,
    composeAnalytics: silentAnalytics,
    ui,
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  const error = await parent
    .parseAsync(['node', 'test', 'init', ...args, '--llm', 'claude-code', '--pm', 'none'])
    .then(
      () => undefined,
      (caught: unknown) => caught,
    )
  return { root, error, ui, run }
}

function writtenConfig(root: string): {
  registry: { targets: Record<string, unknown> }
  use?: { mobile?: unknown }
} {
  return parseYaml(readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8'))
}

const CSV_LINE = '--platform takes web, android and ios, separated by commas.'

describe('--platform takes a CSV of web, android and ios', () => {
  it('web writes a web scaffold and no use.mobile', async () => {
    const { root, error } = await initWithFlags(['--platform', 'web'])

    expect(error).toBeUndefined()
    expect(Object.keys(writtenConfig(root).registry.targets)).toEqual([
      'komazon',
      'komazon-cart-total-bug',
    ])
    expect(writtenConfig(root).use?.mobile).toBeUndefined()
    expect(existsSync(join(root, 'tests/examples/komazon-checkout.yaml'))).toBe(true)
  })

  it('web,android writes the web examples and an android target', async () => {
    const { root, error } = await initWithFlags(['--platform', 'web,android'])

    expect(error).toBeUndefined()
    expect(Object.keys(writtenConfig(root).registry.targets)).toEqual([
      'komazon',
      'komazon-cart-total-bug',
      'example-android',
    ])
    expect(writtenConfig(root).use?.mobile).toBeDefined()
    expect(existsSync(join(root, 'tests/examples/komazon-checkout.yaml'))).toBe(true)
  })

  it('android,ios writes no web examples and a use.mobile block', async () => {
    const { root, error } = await initWithFlags(['--platform', 'android,ios'])

    expect(error).toBeUndefined()
    expect(Object.keys(writtenConfig(root).registry.targets)).toEqual([
      'example-android',
      'example-ios',
    ])
    expect(writtenConfig(root).use?.mobile).toBeDefined()
    expect(existsSync(join(root, 'tests/examples'))).toBe(false)
  })

  it('ios,web writes the same config as web,ios', async () => {
    const first = await initWithFlags(['--platform', 'ios,web'])
    const second = await initWithFlags(['--platform', 'web,ios'])

    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    expect(readFileSync(join(first.root, 'agent-qa.config.yaml'), 'utf8')).toBe(
      readFileSync(join(second.root, 'agent-qa.config.yaml'), 'utf8'),
    )
    expect(Object.keys(writtenConfig(first.root).registry.targets)).toContain('example-ios')
  })

  it.each([
    ['web+android', '--platform web+android is now --platform web,android.'],
    ['web+ios', '--platform web+ios is now --platform web,ios.'],
    ['mobile', CSV_LINE],
    ['web,,', CSV_LINE],
  ])('--platform %s is refused with exit 2 and writes nothing', async (value, message) => {
    const { root, error } = await initWithFlags(['--platform', value])

    expect((error as Error | undefined)?.message).toBe(message)
    expect(error).toMatchObject({ exitCode: 2 })
    expect(readdirSync(root)).toEqual(['.git'])
  })

  it.each([
    ['web+android', '--platform web+android is now --platform web,android.'],
    ['web+ios', '--platform web+ios is now --platform web,ios.'],
    ['mobile', CSV_LINE],
  ])(
    '--platform %s under --json is one refused document with the message',
    async (value, message) => {
      await initWithFlags(['--platform', value, '--json'])

      const documents = stdout.mock.calls.map((call) => JSON.parse(String(call[0])))
      expect(documents).toHaveLength(1)
      expect(documents[0]).toMatchObject({ outcome: 'refused', exitCode: 2, message })
    },
  )
})

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
}

function browserInstalls(run: FakeRunner): string[][] {
  return run.calls.filter((call) => call.args.includes('install-browsers')).map((call) => call.args)
}

describe('the Chromium step follows --no-browsers and the platform', () => {
  it('--no-browsers runs no browser install, skips the step with its command and writes the same files', async () => {
    const without = await initWithFlags(['--platform', 'web'])
    const withFlag = await initWithFlags(['--platform', 'web', '--no-browsers'])

    expect(without.error).toBeUndefined()
    expect(withFlag.error).toBeUndefined()
    expect(browserInstalls(withFlag.run)).toEqual([])
    expect(withFlag.ui.entries).toContainEqual({
      kind: 'skipped',
      text: 'Chromium: skipped (--no-browsers)',
    })
    expect(filesUnder(withFlag.root)).toEqual(filesUnder(without.root))
    expect(readFileSync(join(withFlag.root, 'agent-qa.config.yaml'), 'utf8')).toBe(
      readFileSync(join(without.root, 'agent-qa.config.yaml'), 'utf8'),
    )
  })

  it('--no-browsers carries the install command in the document', async () => {
    await initWithFlags(['--platform', 'web', '--no-browsers', '--json'])

    expect(lastDocument().steps).toContainEqual({
      name: 'chromium',
      outcome: 'skipped',
      reason: '--no-browsers',
      command: 'npx agent-qa install-browsers --chromium',
    })
  })

  it('--platform android,ios skips the step with no web target and runs no browser install', async () => {
    const { error, ui, run } = await initWithFlags(['--platform', 'android,ios'])

    expect(error).toBeUndefined()
    expect(browserInstalls(run)).toEqual([])
    expect(ui.entries).toContainEqual({ kind: 'skipped', text: 'Chromium: no web target' })
  })

  it('--platform web installs Chromium once and draws it done', async () => {
    const { error, ui, run } = await initWithFlags(['--platform', 'web'])

    expect(error).toBeUndefined()
    expect(browserInstalls(run)).toHaveLength(1)
    expect(ui.entries).toContainEqual({ kind: 'done', text: 'Chromium installed' })
  })
})

function lastDocument(): InitDocument {
  const documents = stdout.mock.calls.map((call) => JSON.parse(String(call[0])) as InitDocument)
  expect(documents).toHaveLength(1)
  return documents[0]!
}

describe('--agents answers the coding agents question', () => {
  it.each([
    ['codex', ['codex']],
    ['all', ['claude-code', 'codex']],
    ['none', []],
    ['codex, claude-code', ['claude-code', 'codex']],
  ])('--agents %s records %j in the document', async (value, agents) => {
    const { error } = await initWithFlags(['--platform', 'web', '--agents', value, '--json'])

    expect(error).toBeUndefined()
    expect(lastDocument().agents).toEqual(agents)
  })

  it('--json with nothing detected records both agents in the document', async () => {
    const { error } = await initWithFlags(['--platform', 'web', '--json'])

    expect(error).toBeUndefined()
    expect(lastDocument().agents.join(', ')).toBe('claude-code, codex')
  })

  it('--agents codex in a terminal answers the question without drawing it', async () => {
    const ui = fakeInitUi()

    await initInATerminal(['--platform', 'web', '--agents', 'codex'], ui)

    expect(questions(ui)).toEqual(['Which model should agent-qa use?'])
  })

  it('--agents cursor is refused with exit 2 and writes nothing', async () => {
    const { root, error } = await initWithFlags(['--platform', 'web', '--agents', 'cursor'])

    expect(error).toMatchObject({
      exitCode: 2,
      message: 'Unknown coding agent "cursor". Use claude-code, codex, all or none.',
    })
    expect(readdirSync(root)).toEqual(['.git'])
  })

  it('init help names --agents and its four values', () => {
    const help = createInitCommand().helpInformation()
    const line = help.split('\n').find((entry) => entry.startsWith('  --agents <list>'))

    expect(line).toBeDefined()
    for (const value of ['claude-code', 'codex', 'all', 'none']) expect(help).toContain(value)
  })
})
