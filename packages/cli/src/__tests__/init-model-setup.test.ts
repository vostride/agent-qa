// Init's model question, the flags that answer it, the entry it writes and the next steps.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'

import { S_BAR_END, S_RADIO_ACTIVE, S_STEP_ACTIVE, S_STEP_SUBMIT } from '@clack/prompts'
import { AgentQaConfigSchema, getAuthPath } from '@vostride/agent-qa-core'
import { getProvider } from '@vostride/agent-qa-model'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { createInitCommand, EXAMPLE_SECRET_LINE } from '../commands/init.js'
import { INIT_MODEL_CHOICES } from '../commands/init-model-choice.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { KEY, answeringTerminal, clackStreams, type ClackStreams } from './clack-keys.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  mobileInitFakes,
  tempProject,
} from './project-fixtures.js'

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
    ...mobileInitFakes().hooks,
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
function initOnTheRail(
  args: readonly string[],
  store: Record<string, unknown>,
  streams: ClackStreams = clackStreams(),
): RailRun {
  const { root, home } = projectWithStore(store)
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

// The question as a terminal shows it now, from the guide line above it to its └.
function questionFrame(streams: ClackStreams): string[] {
  const lines = streams.screen()
  const at = lines.findIndex((line) => line.includes(MODEL_QUESTION))
  const end = lines.findIndex((line, index) => index > at && line.startsWith(S_BAR_END))
  return at < 1 || end < 0 ? [] : lines.slice(at - 1, end + 1)
}

async function frameWhere(
  streams: ClackStreams,
  drawn: (frame: string[]) => boolean,
): Promise<string[]> {
  for (let waited = 0; waited < 3000; waited += 10) {
    const frame = questionFrame(streams)
    if (drawn(frame)) return frame
    await sleep(10)
  }
  throw new Error(`the question never drew the expected frame:\n${streams.screen().join('\n')}`)
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
    .filter((entry) => ['select', 'multiselect'].includes(entry.kind))
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
  it('lists the new choices, then the saved credentials, each under a heading, and Enter takes claude-code', async () => {
    const run = initOnTheRail(['--platform', 'web'], SIGNED_IN_AND_WORK_KEY)
    await run.streams.waitFor(MODEL_QUESTION)
    const drawn = stripVTControlCharacters(run.streams.text())
    await run.streams.press(KEY.enter)
    await run.done

    const question = drawn.slice(drawn.lastIndexOf('\n', drawn.indexOf(MODEL_QUESTION)) + 1)
    const order = [
      'Connect a new model',
      'Claude subscription (Claude Code)',
      'ChatGPT subscription (Codex)',
      'Anthropic API',
      'OpenAI API',
      'Gemini API',
      'OpenAI-compatible endpoint',
      'Anthropic-compatible endpoint',
      'Saved on this machine (2)',
      'claude-code (',
      'work (',
    ].map((text) => question.indexOf(text))
    expect(order.every((at) => at > -1)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const lines = question.split('\n')
    expect(lines[0]?.startsWith(S_STEP_ACTIVE)).toBe(true)
    const active = lines.filter((line) => line.includes(S_RADIO_ACTIVE))
    expect(active).toHaveLength(1)
    expect(active[0]).toContain('claude-code (')
    const headingTexts = ['Connect a new model', 'Saved on this machine (2)']
    const headings = lines.filter((line) => headingTexts.some((text) => line.includes(text)))
    expect(headings.map((line) => line.replace(/^\S\s\s/u, ''))).toEqual(headingTexts)
    const answered = stripVTControlCharacters(run.streams.text())
      .split('\n')
      .filter((line) => line.includes(MODEL_QUESTION))
      .at(-1)
    expect(answered?.startsWith(S_STEP_SUBMIT)).toBe(true)

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

describe('the model question in a terminal shorter than its list', () => {
  const TWELVE_GEMINI_KEYS = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `g${String(index + 1).padStart(2, '0')}`,
      { type: 'api', provider: 'gemini', key: DUMMY_KEY },
    ]),
  )

  it('scrolls to the saved credentials with their heading on the first list line, and Enter takes the row under the cursor', async () => {
    const streams = clackStreams({ rows: 12 })
    const run = initOnTheRail(['--platform', 'web'], TWELVE_GEMINI_KEYS, streams)
    await streams.waitFor(MODEL_QUESTION)
    await frameWhere(streams, (frame) =>
      frame.some((line) => line.includes(S_RADIO_ACTIVE) && line.includes('g01 (')),
    )
    await streams.press(...Array<string>(6).fill(KEY.down))
    const frame = await frameWhere(streams, (lines) =>
      lines.some((line) => line.includes(S_RADIO_ACTIVE) && line.includes('g07 (')),
    )
    await streams.press(KEY.enter)
    await run.done

    expect(frame.length).toBeLessThan(12)
    const question = frame.findIndex((line) => line.includes(MODEL_QUESTION))
    expect(frame[question]?.startsWith(S_STEP_ACTIVE)).toBe(true)
    expect(frame[question + 1]).toContain('Saved on this machine (12)')
    expect(frame.some((line) => line.includes('Connect a new model'))).toBe(false)
    const active = frame.filter((line) => line.includes(S_RADIO_ACTIVE))
    expect(active).toHaveLength(1)
    expect(active[0]).toContain('g07 (')

    const config = writtenConfig(run.root)
    expect(config.registry.llms).toEqual([
      { name: 'g07', provider: 'gemini', model: registryDefault('gemini') },
    ])
    expect(config.use.llm).toBe('g07')
    expectNoDummySecret(run.root, streams.text(), processOutput())
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

  it('an endpoint given --base-url without --model is refused with exit 2 and nothing is written', async () => {
    const { root, error } = await init([
      '--platform',
      'web',
      '--llm',
      'openai-compatible',
      '--base-url',
      'https://llm.local/v1',
    ])

    expect(error).toMatchObject({ exitCode: 2 })
    expect((error as Error).message).toMatch(/^--model is missing: /u)
    expect(readdirSync(root)).toEqual(['.git'])
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
})

const GETTING_STARTED = 'https://vostride.com/docs/agent-qa/quickstart'

function nextStepNotes(ui: FakeInitUi): string[][] {
  return ui.entries.flatMap((entry) =>
    entry.kind === 'note' && entry.text === 'Next steps' ? [entry.lines] : [],
  )
}

describe('init next steps', () => {
  it('a Codex subscription under --pm none lists the install, validate, its sign-in, the dashboard and the starter in one box', async () => {
    const { ui } = await init(['--platform', 'web', '--llm', 'codex'])

    expect(nextStepNotes(ui)).toEqual([
      [
        'npm install',
        'npx agent-qa validate',
        '',
        'Sign in with your subscription:',
        'npx agent-qa auth login --config codex',
        '',
        'Run a test in the dashboard:',
        'npx agent-qa dashboard',
        '',
        'Run a test from the terminal:',
        'npx agent-qa run tests/examples/komazon-cart-total.yaml',
      ],
    ])
    expect(ui.entries.at(-1)).toEqual({ kind: 'outro', text: GETTING_STARTED })
    expect(ui.output()).not.toContain('agent-qa doctor')
  })

  it('an API-key workspace is sent to the dashboard for its key, with no auth login or plugin line', async () => {
    const { ui } = await init(['--platform', 'web', '--llm', 'anthropic'])

    const [box] = nextStepNotes(ui)
    expect(box).toContain('npx agent-qa dashboard')
    expect(ui.output()).not.toContain('auth login')
    expect(ui.output()).not.toContain('auth set')
    expect(ui.output()).not.toContain(SUBSCRIPTION_AUTH_PACKAGE)
  })

  it.each([
    [['--platform', 'web', '--llm', 'codex']],
    [['--platform', 'web']],
    [['--platform', 'web', '--llm', 'anthropic']],
    [['--platform', 'web', '--llm', 'openai-compatible']],
    [['--platform', 'android']],
  ])('under --pm none the next steps of %j name validate', async (args) => {
    const { ui } = await init(args)

    const lines = ui.output().split('\n')
    const start = lines.findIndex((line) => line === 'Next steps')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(lines.slice(start).some((line) => line.includes('npx agent-qa validate'))).toBe(true)
  })
})

describe('the example secret line', () => {
  const WEB = ['--platform', 'web', '--llm', 'gemini', '--agents', 'none', '--pm', 'none']
  const HINT = 'Add this line to .env.secrets.local so the examples can sign in:'

  async function forceOver(secrets: string, ui: FakeInitUi): Promise<void> {
    const { root, home } = projectWithStore()
    await initCommand(root, home, { isTTY: false, ui: fakeInitUi() }).parseAsync([
      'node',
      'test',
      'init',
      ...WEB,
    ])
    writeFileSync(join(root, '.env.secrets.local'), secrets)
    await initCommand(root, home, { isTTY: false, ui }).parseAsync([
      'node',
      'test',
      'init',
      ...WEB,
      '--force',
    ])
  }

  function secretEntries(ui: FakeInitUi) {
    return ui.entries.filter(
      (entry) =>
        (entry.kind === 'line' && entry.text === HINT) ||
        (entry.kind === 'copyable' && entry.text === EXAMPLE_SECRET_LINE),
    )
  }

  it('--force over a kept secrets file that holds KOMAZON_PASSWORD prints no example line', async () => {
    const ui = fakeInitUi()

    await forceOver('KOMAZON_PASSWORD=x\n', ui)

    expect(secretEntries(ui)).toEqual([])
  })

  it('--force over a kept secrets file without it prints the hint and the line once', async () => {
    const ui = fakeInitUi()

    await forceOver('OTHER_SECRET=y\n', ui)

    expect(secretEntries(ui)).toEqual([
      { kind: 'line', text: HINT },
      { kind: 'copyable', text: EXAMPLE_SECRET_LINE },
    ])
  })

  it('on the rail the example line is drawn flush left, so it copies without a gutter', async () => {
    const { root, home } = projectWithStore()
    await initCommand(root, home, { isTTY: false, ui: fakeInitUi() }).parseAsync([
      'node',
      'test',
      'init',
      ...WEB,
    ])
    writeFileSync(join(root, '.env.secrets.local'), 'OTHER_SECRET=y\n')
    const streams = clackStreams()

    await initCommand(root, home, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      terminal: answeringTerminal().port,
      rail: { input: streams.input, output: streams.output },
    }).parseAsync(['node', 'test', 'init', ...WEB, '--force'])

    const lines = stripVTControlCharacters(streams.text()).split('\n')
    expect(lines.filter((line) => line.includes('KOMAZON_PASSWORD'))).toEqual([EXAMPLE_SECRET_LINE])
  })
})
