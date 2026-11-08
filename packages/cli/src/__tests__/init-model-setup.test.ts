// Init's model question, the flags that answer it, the entry it writes and the next steps.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { S_RADIO_ACTIVE } from '@clack/prompts'
import { AgentQaConfigSchema, getAuthPath } from '@vostride/agent-qa-core'
import { getProvider } from '@vostride/agent-qa-model'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { createInitCommand, EXAMPLE_SECRET_LINE } from '../commands/init.js'
import { INIT_MODEL_CHOICES } from '../commands/init-model-choice.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '../model-defaults.js'
import { KEY, answeringTerminal, clackStreams, type ClackStreams } from './clack-keys.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import { cleanupTempProjects, fakeRunner, tempProject } from './project-fixtures.js'

const SUBSCRIPTION_AUTH_PACKAGE = '@vostride/agent-qa-subscription-auth'
const MODEL_QUESTION = 'Which model should agent-qa use?'
const DUMMY_TOKEN = 'DUMMY-INIT-TOKEN-7f3a'
const DUMMY_KEY = 'DUMMY-INIT-KEY-91c2'
const DUMMIES = [DUMMY_TOKEN, DUMMY_KEY]

const SIGNED_IN_AND_WORK_KEY = {
  'claude-code': {
    type: 'oauth',
    provider: 'anthropic-subscription',
    tokens: { access: DUMMY_TOKEN, refresh: DUMMY_TOKEN, expires: 0 },
  },
  work: { type: 'api', provider: 'openai-compatible', key: DUMMY_KEY },
}

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-model-setup', runtimeContext: 'user' }),
  })

interface InitRun {
  root: string
  error: unknown
  ui: FakeInitUi
}

function projectWithStore(store?: Record<string, unknown>): { root: string; home: string } {
  const project = tempProject('init-model')
  if (store !== undefined) {
    const path = getAuthPath({ env: {}, homeDir: project.home })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(store), 'utf8')
  }
  return project
}

function initCommand(root: string, home: string, extra: Parameters<typeof createInitCommand>[0]) {
  const parent = new Command()
  const command = createInitCommand({
    cwd: root,
    host: { homedir: home, env: {}, run: fakeRunner() },
    composeAnalytics: silentAnalytics,
    ...extra,
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  return parent
}

// No test starts a package manager: init declares the dependencies and runs no install.
async function init(
  args: readonly string[],
  options: { store?: Record<string, unknown>; isTTY?: boolean; ui?: FakeInitUi } = {},
): Promise<InitRun> {
  const { root, home } = projectWithStore(options.store)
  const ui = options.ui ?? fakeInitUi()
  const error = await initCommand(root, home, { isTTY: options.isTTY ?? false, ui })
    .parseAsync(['node', 'test', 'init', ...args, '--pm', 'none'])
    .then(
      () => undefined,
      (caught: unknown) => caught,
    )
  return { root, error, ui }
}

interface RailRun {
  root: string
  streams: ClackStreams
  done: Promise<void>
}

// The coding agents are given, so the model question is the only one drawn.
function initOnTheRail(args: readonly string[], store: Record<string, unknown>): RailRun {
  const { root, home } = projectWithStore(store)
  const streams = clackStreams()
  const done = initCommand(root, home, {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    terminal: answeringTerminal().port,
    rail: { input: streams.input, output: streams.output },
  })
    .parseAsync(['node', 'test', 'init', ...args, '--agents', 'claude-code', '--pm', 'none'])
    .then(() => {})
  return { root, streams, done }
}

async function pickOnTheRail(downs: number): Promise<RailRun> {
  const run = initOnTheRail(['--platform', 'web'], SIGNED_IN_AND_WORK_KEY)
  await run.streams.waitFor(MODEL_QUESTION)
  await run.streams.press(...Array<string>(downs).fill(KEY.down), KEY.enter)
  await run.done
  return run
}

function configText(root: string): string {
  return readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8')
}

function writtenConfig(root: string): any {
  return parseYaml(configText(root))
}

function registryDefault(provider: string): string {
  const model = getProvider(provider)?.defaultModel
  expect(model, `${provider} has a registry default model`).toMatch(/\S/u)
  return model!
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function expectNoDummySecret(root: string, ...outputs: string[]): void {
  const written = filesUnder(root).map((path) => readFileSync(path, 'utf8'))
  for (const text of [...outputs, ...written]) {
    for (const secret of DUMMIES) expect(text).not.toContain(secret)
  }
}

function questions(ui: FakeInitUi): string[] {
  return ui.entries
    .filter((entry) => ['select', 'multiselect', 'text'].includes(entry.kind))
    .map((entry) => entry.text)
}

let stdout: MockInstance<typeof process.stdout.write>
let stderr: MockInstance<typeof process.stderr.write>

function processOutput(): string {
  return [...stdout.mock.calls, ...stderr.mock.calls].map((call) => String(call[0])).join('')
}

beforeEach(() => {
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempProjects()
})

describe('the model question on the rail', () => {
  it('lists the saved credentials before the new choices, starts on claude-code and asks no follow-up', async () => {
    const run = initOnTheRail(['--platform', 'web'], SIGNED_IN_AND_WORK_KEY)
    await run.streams.waitFor(MODEL_QUESTION)
    const drawn = stripVTControlCharacters(run.streams.text())
    await run.streams.press(KEY.enter)
    await run.done

    const question = drawn.slice(drawn.indexOf(MODEL_QUESTION))
    const firstNew = question.indexOf('Claude subscription (Claude Code)')
    expect(question.indexOf('claude-code (')).toBeGreaterThan(-1)
    expect(question.indexOf('claude-code (')).toBeLessThan(firstNew)
    expect(question.indexOf('work (')).toBeGreaterThan(-1)
    expect(question.indexOf('work (')).toBeLessThan(firstNew)
    const active = question.split('\n').filter((line) => line.includes(S_RADIO_ACTIVE))
    expect(active).toHaveLength(1)
    expect(active[0]).toContain('claude-code (')

    const config = writtenConfig(run.root)
    expect(config.registry.llms).toEqual([
      {
        name: 'claude-code',
        provider: 'anthropic-subscription',
        model: registryDefault('anthropic-subscription'),
      },
    ])
    expect(config.use.llm).toBe('claude-code')
    const text = stripVTControlCharacters(run.streams.text())
    expect(text).not.toContain('Model:')
    expect(text).not.toContain('Base URL:')
    expectNoDummySecret(run.root, run.streams.text(), processOutput())
  })

  it('OpenAI API writes the openai entry with the official base URL', async () => {
    const run = await pickOnTheRail(5)

    expect(writtenConfig(run.root).registry.llms).toEqual([
      {
        name: 'openai',
        provider: 'openai-compatible',
        model: registryDefault('openai-compatible'),
        baseURL: 'https://api.openai.com/v1',
      },
    ])
    expect(writtenConfig(run.root).use.llm).toBe('openai')
    expectNoDummySecret(run.root, run.streams.text(), processOutput())
  })

  it.each([
    { name: 'the saved work key', downs: 1 },
    { name: 'OpenAI-compatible endpoint', downs: 7 },
  ])('$name writes no model entry and no use.llm, and the config parses strictly', async (cell) => {
    const run = await pickOnTheRail(cell.downs)

    const config = writtenConfig(run.root)
    expect(config.registry.llms).toBeUndefined()
    expect(config.use.llm).toBeUndefined()
    expect(AgentQaConfigSchema.safeParse(config).success).toBe(true)
    expectNoDummySecret(run.root, run.streams.text(), processOutput())
  })
})

describe('the model question without a terminal', () => {
  it('with no flags and an empty store, init writes the Claude subscription entry and asks nothing', async () => {
    const { root, error, ui } = await init([])

    expect(error).toBeUndefined()
    const config = writtenConfig(root)
    expect(config.registry.llms).toEqual([
      {
        name: 'claude-code',
        provider: 'anthropic-subscription',
        model: registryDefault('anthropic-subscription'),
      },
    ])
    expect(config.use.llm).toBe('claude-code')
    expect(config.plugins).toEqual([{ name: 'subscription', package: SUBSCRIPTION_AUTH_PACKAGE }])
    expect(readFileSync(join(root, '.env.secrets.local'), 'utf8').split('\n')).toContain(
      EXAMPLE_SECRET_LINE,
    )
    expect(questions(ui)).toEqual([])
  })

  it('takes a saved sign-in without being asked', async () => {
    const { root, ui } = await init(['--platform', 'web'], { store: SIGNED_IN_AND_WORK_KEY })

    expect(writtenConfig(root).use.llm).toBe('claude-code')
    expect(questions(ui)).toEqual([])
    expectNoDummySecret(root, ui.output(), processOutput())
  })
})

describe('--llm, --model and --base-url', () => {
  it('--llm gemini writes the gemini entry with no base URL and no plugin', async () => {
    const { root } = await init(['--platform', 'web', '--llm', 'gemini'])

    const config = writtenConfig(root)
    expect(config.registry.llms).toEqual([
      { name: 'gemini', provider: 'gemini', model: registryDefault('gemini') },
    ])
    expect(config.use.llm).toBe('gemini')
    expect(config).not.toHaveProperty('plugins')
  })

  it('--llm codex writes the codex entry on the Codex subscription and declares the plugin', async () => {
    const { root } = await init(['--platform', 'web', '--llm', 'codex'])

    const config = writtenConfig(root)
    expect(config.registry.llms).toEqual([
      {
        name: 'codex',
        provider: 'openai-subscription',
        model: registryDefault('openai-subscription'),
      },
    ])
    expect(config.use.llm).toBe('codex')
    expect(config.plugins).toEqual([{ name: 'subscription', package: SUBSCRIPTION_AUTH_PACKAGE }])
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain(SUBSCRIPTION_AUTH_PACKAGE)
  })

  it('--llm with a saved compatible key writes no entry', async () => {
    const { root, error, ui } = await init(['--platform', 'web', '--llm', 'work'], {
      store: SIGNED_IN_AND_WORK_KEY,
    })

    expect(error).toBeUndefined()
    const config = writtenConfig(root)
    expect(config.registry.llms).toBeUndefined()
    expect(config.use.llm).toBeUndefined()
    expectNoDummySecret(root, ui.output(), processOutput())
  })

  it('--llm openai-compatible with --base-url and --model writes a complete endpoint entry', async () => {
    const { root } = await init([
      '--platform',
      'web',
      '--llm',
      'openai-compatible',
      '--base-url',
      ' https://llm.local/v1 ',
      '--model',
      ' m ',
    ])

    expect(writtenConfig(root).registry.llms).toEqual([
      {
        name: 'openai-compatible',
        provider: 'openai-compatible',
        model: 'm',
        baseURL: 'https://llm.local/v1',
      },
    ])
    expect(AgentQaConfigSchema.safeParse(writtenConfig(root)).success).toBe(true)
  })

  it('a blank --model is refused with exit 2 and nothing is written', async () => {
    const { root, error } = await init(['--platform', 'web', '--model', '  '])

    expect(error).toMatchObject({ exitCode: 2, message: '--model must not be empty' })
    expect(readdirSync(root)).toEqual(['.git'])
  })

  it('an unknown --llm is refused with exit 2 naming the seven choices, and nothing is written', async () => {
    const { root, error } = await init(['--platform', 'web', '--llm', 'nope'])

    expect(error).toMatchObject({ exitCode: 2 })
    for (const choice of INIT_MODEL_CHOICES) expect((error as Error).message).toContain(choice)
    expect((error as Error).message).not.toContain('nope')
    expect(readdirSync(root)).toEqual(['.git'])
  })

  it('a base URL on a provider that takes none is refused with exit 2 and nothing is written', async () => {
    const { root, error } = await init([
      '--platform',
      'web',
      '--llm',
      'codex',
      '--base-url',
      'https://x.test/v1',
    ])

    expect(error).toMatchObject({ exitCode: 2 })
    expect(readdirSync(root)).toEqual(['.git'])
  })

  it('--llm answers the question in a terminal, and without it the question is asked', async () => {
    const flagged = await init(['--platform', 'web', '--llm', 'codex'], { isTTY: true })
    expect(questions(flagged.ui)).not.toContain(MODEL_QUESTION)
    expect(writtenConfig(flagged.root).use.llm).toBe('codex')

    const asked = await init(['--platform', 'web'], {
      isTTY: true,
      ui: fakeInitUi({ [MODEL_QUESTION]: { kind: 'new', choice: 'gemini' } }),
    })
    expect(questions(asked.ui)).toContain(MODEL_QUESTION)
    expect(writtenConfig(asked.root).use.llm).toBe('gemini')
  })

  it('init help names the seven --llm choices, --model and --base-url', () => {
    const help = createInitCommand().helpInformation()
    const lines = help.split('\n')
    const start = lines.findIndex((line) => line.startsWith('  --llm <choice>'))
    expect(start).toBeGreaterThanOrEqual(0)
    const next = lines.findIndex((line, index) => index > start && /^\s{2}-/u.test(line))
    const entry = lines.slice(start, next).join(' ')
    for (const choice of INIT_MODEL_CHOICES) expect(entry).toContain(choice)
    expect(entry).toContain('saved credential')
    expect(lines.some((line) => line.startsWith('  --model <id>'))).toBe(true)
    expect(lines.some((line) => line.startsWith('  --base-url <url>'))).toBe(true)
    expect(help).not.toMatch(/--(api-key|token|key|secret)\b/u)
  })
})

describe('subscription model defaults', () => {
  it('--llm codex with no --model writes gpt-6.1-sol', async () => {
    const { root } = await init(['--platform', 'web', '--llm', 'codex'])

    expect(writtenConfig(root).registry.llms).toEqual([
      { name: 'codex', provider: 'openai-subscription', model: 'gpt-6.1-sol' },
    ])
  })

  it('--llm claude-code with no --model writes claude-sonnet-5-5', async () => {
    const { root } = await init(['--platform', 'web', '--llm', 'claude-code'])

    expect(writtenConfig(root).registry.llms).toEqual([
      { name: 'claude-code', provider: 'anthropic-subscription', model: 'claude-sonnet-5-5' },
    ])
  })

  it('the CLI subscription defaults equal the provider registry defaults', () => {
    expect(DEFAULT_OPENAI_MODEL).toBe(getProvider('openai-subscription')?.defaultModel)
    expect(DEFAULT_ANTHROPIC_MODEL).toBe(getProvider('anthropic-subscription')?.defaultModel)
    expect([DEFAULT_OPENAI_MODEL, DEFAULT_ANTHROPIC_MODEL]).toEqual([
      'gpt-6.1-sol',
      'claude-sonnet-5-5',
    ])
  })
})

const GETTING_STARTED = 'https://vostride.com/docs/agent-qa/quickstart'
const RUN_EXAMPLES = 'npx agent-qa run suites/examples.suite.yaml'

function lineWith(output: string, text: string): string {
  const line = output.split('\n').find((entry) => entry.includes(text))
  expect(line, `init printed ${text}`).toBeDefined()
  return line!
}

describe('init next steps', () => {
  it('the next steps follow the route order for a subscription workspace', async () => {
    const { ui } = await init(['--platform', 'web', '--llm', 'codex'])

    const output = ui.output()
    const order = [
      'npx agent-qa install-browsers --chromium',
      `npx agent-qa plugins add ${SUBSCRIPTION_AUTH_PACKAGE}`,
      'npx agent-qa auth login --config codex',
      'npx agent-qa validate',
      RUN_EXAMPLES,
      GETTING_STARTED,
    ]
    const positions = order.map((text) => output.indexOf(text))
    for (const [index, text] of order.entries()) {
      expect(positions[index], text).toBeGreaterThanOrEqual(0)
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    const run = lineWith(output, RUN_EXAMPLES)
    expect(run).toContain('one passes')
    expect(run).toContain('exit 1')
    expect(output).not.toContain('agent-qa doctor')
  })

  it('an API-key workspace is told to save its key with auth set and the hidden prompt', async () => {
    const { ui } = await init(['--platform', 'web', '--llm', 'anthropic'])

    const output = ui.output()
    const apiKey = lineWith(output, 'npx agent-qa auth set --config anthropic --type api-key')
    expect(apiKey).toContain('hidden prompt')
    lineWith(output, 'npx agent-qa auth set --config anthropic --type bearer-token')
    expect(output.indexOf('npx agent-qa install-browsers --chromium')).toBeLessThan(
      output.indexOf('npx agent-qa auth set'),
    )
    expect(output.indexOf('npx agent-qa auth set')).toBeLessThan(
      output.indexOf('npx agent-qa validate'),
    )
    expect(output).not.toContain('auth login')
    expect(output).not.toContain(SUBSCRIPTION_AUTH_PACKAGE)
  })

  it.each([
    [['--platform', 'web', '--llm', 'codex']],
    [['--platform', 'web']],
    [['--platform', 'web', '--llm', 'anthropic']],
    [['--platform', 'web', '--llm', 'openai-compatible']],
    [['--platform', 'android']],
  ])('the next steps of %j name validate', async (args) => {
    const { ui } = await init(args)

    const lines = ui.output().split('\n')
    const start = lines.findIndex((line) => line === 'Next steps')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(lines.slice(start).some((line) => line.includes('npx agent-qa validate'))).toBe(true)
  })
})
