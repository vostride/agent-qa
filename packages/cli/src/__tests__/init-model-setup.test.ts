// C445-INIT-LLM (445-04, D-11, D-36): init's model connection flags and their defaults
// C445-INIT-PROMPTS (445-04, D-11): a terminal init asks only defaulted questions whose flag is absent
// C445-MODEL-DEFAULTS (445-05, D-31, D-36): current subscription defaults, same in CLI and registry
// C445-NEXT-STEPS (445-05, D-14, D-17): init prints its next steps in the route order
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { parse as parseYaml } from 'yaml'

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('../commands/init-filesystem.js', async () => {
  const fs = await import('node:fs')
  const writePlan = (plan: {
    path: string
    content: string | Uint8Array
    force?: boolean
    preserveOnForce?: boolean
  }) => {
    const exists = fs.existsSync(plan.path)
    if (exists && (!plan.force || plan.preserveOnForce)) {
      return { path: plan.path, outcome: 'preserved' as const }
    }
    fs.writeFileSync(plan.path, plan.content)
    return { path: plan.path, outcome: exists ? 'updated' as const : 'created' as const }
  }

  return {
    KNOWLEDGE_GITIGNORE_PROBES: [],
    TARGET_GITIGNORE_PROBES: [],
    classifyInitPath: vi.fn((path: string) => fs.existsSync(path) ? 'regular' : 'missing'),
    preflightInitPlan: vi.fn((plans: Array<{ path: string }>) => plans.map(plan => ({
      path: plan.path,
      classification: fs.existsSync(plan.path) ? 'regular' : 'missing',
    }))),
    writeScaffoldFileAtomic: vi.fn(writePlan),
    writeConfigMarkerLast: vi.fn(writePlan),
    upsertManagedGitignoreBlock: vi.fn((path: string) => {
      fs.writeFileSync(path, '# agent-qa init:start\n.agent-qa/\n# agent-qa init:end\n')
      return { path, outcome: 'created' as const }
    }),
    verifyEffectiveGitignore: vi.fn(() => ({ checked: true })),
  }
})

vi.mock('../commands/install-browsers.js', () => ({
  formatInstallBrowsersRetryCommand: vi.fn(() => 'agent-qa install-browsers --chromium'),
  runBrowserInstall: vi.fn(() => ({ ok: true, status: 0, stage: 'installer' })),
}))

vi.mock('@inquirer/select', () => ({ default: vi.fn() }))
vi.mock('@inquirer/input', () => ({ default: vi.fn() }))
vi.mock('@inquirer/checkbox', () => ({ default: vi.fn() }))
vi.mock('@inquirer/confirm', () => ({ default: vi.fn() }))
vi.mock('@inquirer/password', () => ({ default: vi.fn() }))

vi.mock('@vostride/agent-qa-core', () => ({
  writeAuth: vi.fn(() => Promise.resolve()),
  resolveAppiumExecutable: vi.fn(() => ({ command: 'appium', source: 'path' })),
  formatAppiumInstallGuidance: vi.fn(() => 'Install Appium locally.'),
  DEFAULT_AGENT_QA_AUTH_STATES_DIR: '.agent-qa/auth-states',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_RUNTIME_DIR: '.agent-qa',
  getAgentQaVersion: vi.fn(() => '0.1.1'),
}))

import { createInitCommand, EXAMPLE_SECRET_LINE, INIT_LLM_CHOICES } from '../commands/init.js'
import { preflightInitPlan, writeScaffoldFileAtomic } from '../commands/init-filesystem.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import select from '@inquirer/select'
import input from '@inquirer/input'
import checkbox from '@inquirer/checkbox'
import confirm from '@inquirer/confirm'
import password from '@inquirer/password'
import { getProvider } from '@vostride/agent-qa-model'
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '../model-defaults.js'

const DIR = '/tmp/c445-init-llm'
const SUBSCRIPTION_AUTH_PACKAGE = '@vostride/agent-qa-subscription-auth'
const mockWriteFileSync = vi.mocked(writeFileSync)
const prompts = [select, input, checkbox, confirm, password].map(fn => vi.mocked(fn))

let stderr: string[] = []
let previousExitCode: typeof process.exitCode

let stdout: string[] = []

async function runInit(args: string[], isTTY = false): Promise<void> {
  const parent = new Command()
  const init = createInitCommand({ isTTY } as Parameters<typeof createInitCommand>[0])
  parent.exitOverride()
  init.exitOverride()
  init.configureOutput({
    writeErr: text => { stderr.push(text) },
    writeOut: text => { stdout.push(text) },
  })
  parent.addCommand(init)
  await parent.parseAsync(['node', 'agent-qa', 'init', '--dir', DIR, ...args])
}

async function initOk(args: string[], isTTY = false): Promise<void> {
  await expect(runInit(args, isTTY)).resolves.toBeUndefined()
}

function writtenText(path: string): string {
  const call = mockWriteFileSync.mock.calls.find(entry => String(entry[0]) === `${DIR}/${path}`)
  expect(call, `init wrote ${path}`).toBeDefined()
  return String(call![1])
}

function writtenConfig(): any {
  return parseYaml(writtenText('agent-qa.config.yaml'))
}

function registryDefault(provider: string): string {
  const model = getProvider(provider)?.defaultModel
  expect(model, `${provider} has a registry default model`).toMatch(/\S/u)
  return model!
}

function refusalOutput(): string {
  return [...stderr, ...vi.mocked(console.error).mock.calls.flat().map(String)].join('\n')
}

function expectNothingWritten(): void {
  expect(vi.mocked(preflightInitPlan)).not.toHaveBeenCalled()
  expect(vi.mocked(writeScaffoldFileAtomic)).not.toHaveBeenCalled()
  expect(mockWriteFileSync).not.toHaveBeenCalled()
}

function expectNoPrompt(): void {
  for (const prompt of prompts) expect(prompt).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  stderr = []
  stdout = []
  previousExitCode = process.exitCode
  process.exitCode = undefined
  vi.mocked(existsSync).mockReturnValue(false)
  vi.mocked(readFileSync).mockImplementation(() => '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  process.exitCode = previousExitCode
  vi.restoreAllMocks()
})

describe('C445-INIT-LLM', () => {
  it('--llm codex writes one codex entry on the Codex subscription and declares the plugin', async () => {
    await initOk(['--platform', 'web', '--llm', 'codex'])

    const config = writtenConfig()
    expect(config.registry.llms).toEqual([
      { name: 'codex', provider: 'openai-subscription', model: registryDefault('openai-subscription') },
    ])
    expect(config.use.llm).toBe('codex')
    expect(config.plugins.auth).toEqual([{ package: SUBSCRIPTION_AUTH_PACKAGE }])
    expectNoPrompt()
  })

  it('with no flags and no terminal, init writes the claude-code entry and asks nothing', async () => {
    await initOk([])

    const config = writtenConfig()
    expect(config.registry.llms).toEqual([
      {
        name: 'claude-code',
        provider: 'anthropic-subscription',
        model: registryDefault('anthropic-subscription'),
      },
    ])
    expect(config.use.llm).toBe('claude-code')
    expect(config.plugins.auth).toEqual([{ package: SUBSCRIPTION_AUTH_PACKAGE }])
    for (const path of [
      'tests/examples/komazon-checkout.yaml',
      'tests/examples/komazon-cart-total-bug.yaml',
      'tests/examples/komazon-shipping-hook.yaml',
      'suites/examples.suite.yaml',
    ]) {
      expect(writtenText(path)).toMatch(/\S/u)
    }
    expect(writtenText('.env.secrets.local').split('\n')).toContain(EXAMPLE_SECRET_LINE)
    expectNoPrompt()
  })

  it('--llm anthropic-compatible writes a default entry with the Anthropic API base URL and no plugin', async () => {
    await initOk(['--platform', 'web', '--llm', 'anthropic-compatible'])

    const config = writtenConfig()
    expect(config.registry.llms).toEqual([
      {
        name: 'default',
        provider: 'anthropic-compatible',
        model: registryDefault('anthropic-compatible'),
        baseURL: 'https://api.anthropic.com/v1',
      },
    ])
    expect(config.use.llm).toBe('default')
    expect(config).not.toHaveProperty('plugins')
    expect(mockWriteFileSync.mock.calls.some(call => String(call[0]).endsWith('package.json')))
      .toBe(false)
    expectNoPrompt()
  })

  it('--llm openai-compatible takes --model and --base-url as given', async () => {
    await initOk([
      '--platform', 'web',
      '--llm', 'openai-compatible',
      '--model', 'gpt-test',
      '--base-url', 'https://llm.internal.test/v1',
    ])

    const config = writtenConfig()
    expect(config.registry.llms).toEqual([
      {
        name: 'default',
        provider: 'openai-compatible',
        model: 'gpt-test',
        baseURL: 'https://llm.internal.test/v1',
      },
    ])
    expect(config.use.llm).toBe('default')
    expect(config).not.toHaveProperty('plugins')
    expectNoPrompt()
  })

  it('--llm gemini writes a default entry with no base URL and no plugin', async () => {
    await initOk(['--platform', 'web', '--llm', 'gemini'])

    const config = writtenConfig()
    expect(config.registry.llms).toEqual([
      { name: 'default', provider: 'gemini', model: registryDefault('gemini') },
    ])
    expect(config.use.llm).toBe('default')
    expect(config).not.toHaveProperty('plugins')
    expectNoPrompt()
  })

  it('an unknown --llm value is refused before anything is written', async () => {
    await expect(runInit(['--platform', 'web', '--llm', 'gpt']))
      .rejects.toMatchObject({ code: 'commander.invalidArgument' })

    expect(refusalOutput()).toContain('claude-code')
    expectNothingWritten()
    expectNoPrompt()
  })

  it('a base URL is refused for a provider that takes none or when it is not an absolute http or https URL', async () => {
    await initOk(['--platform', 'web', '--llm', 'codex', '--base-url', 'https://x.test/v1'])
    expect(process.exitCode).toBe(1)
    expect(refusalOutput())
      .toContain('--base-url applies only to --llm openai-compatible or anthropic-compatible')
    expectNothingWritten()

    vi.clearAllMocks()
    stderr = []
    process.exitCode = undefined
    await initOk(['--platform', 'web', '--llm', 'openai-compatible', '--base-url', 'ftp://x.test'])
    expect(process.exitCode).toBe(1)
    expect(refusalOutput()).toContain('--base-url must be an absolute http or https URL')
    expectNothingWritten()
    expectNoPrompt()
  })
})

type PromptCall = { kind: string; config: any }

function promptCalls(): PromptCall[] {
  const kinds = ['select', 'input', 'checkbox', 'confirm', 'password']
  return prompts.flatMap((prompt, index) =>
    prompt.mock.calls.map(call => ({ kind: kinds[index]!, config: call[0] as any })))
}

function answerWithDefaults(): void {
  vi.mocked(checkbox).mockImplementation((async (config: any) =>
    config.choices.filter((choice: any) => choice.checked).map((choice: any) => choice.value)) as any)
  vi.mocked(select).mockImplementation((async (config: any) => config.default) as any)
  vi.mocked(input).mockImplementation((async (config: any) => config.default) as any)
}

function hasDefault(call: PromptCall): boolean {
  if (call.kind === 'checkbox') return call.config.choices.some((choice: any) => choice.checked)
  return call.config.default !== undefined && String(call.config.default).length > 0
}

describe('C445-INIT-PROMPTS', () => {
  beforeEach(answerWithDefaults)

  it('in a terminal with no flags, init asks the platform and the model connection, each with its default', async () => {
    await initOk([], true)

    expect(vi.mocked(checkbox)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(checkbox).mock.calls[0]![0].choices).toContainEqual(
      expect.objectContaining({ value: 'web', checked: true }),
    )
    expect(vi.mocked(select)).toHaveBeenCalledTimes(1)
    const connection = vi.mocked(select).mock.calls[0]![0] as any
    expect(connection.choices.map((choice: any) => choice.value)).toEqual([...INIT_LLM_CHOICES])
    expect(connection.default).toBe('claude-code')
    expect(vi.mocked(input)).not.toHaveBeenCalled()
    expect(writtenConfig().registry.llms).toEqual([
      {
        name: 'claude-code',
        provider: 'anthropic-subscription',
        model: registryDefault('anthropic-subscription'),
      },
    ])
  })

  it('a flag that is given skips its question', async () => {
    await initOk(['--platform', 'web', '--llm', 'codex'], true)
    expectNoPrompt()
    expect(writtenConfig().registry.llms[0].name).toBe('codex')

    vi.clearAllMocks()
    answerWithDefaults()
    await initOk(['--platform', 'web'], true)
    expect(promptCalls().map(call => call.kind)).toEqual(['select'])
  })

  it('the compatible providers ask the model and base URL with their defaults', async () => {
    await initOk(['--platform', 'web', '--llm', 'anthropic-compatible'], true)

    const asked = promptCalls()
    expect(asked.map(call => call.kind)).toEqual(['input', 'input'])
    expect(asked[0]!.config.default).toBe(registryDefault('anthropic-compatible'))
    expect(asked[1]!.config.default).toBe('https://api.anthropic.com/v1')
    expect(asked[1]!.config.validate('ftp://x.test')).toBe('--base-url must be an absolute http or https URL')
    expect(asked[1]!.config.validate('https://llm.internal.test/v1')).toBe(true)
    expect(writtenConfig().registry.llms).toEqual([
      {
        name: 'default',
        provider: 'anthropic-compatible',
        model: registryDefault('anthropic-compatible'),
        baseURL: 'https://api.anthropic.com/v1',
      },
    ])

    vi.clearAllMocks()
    answerWithDefaults()
    await initOk([
      '--platform', 'web',
      '--llm', 'anthropic-compatible',
      '--model', 'claude-test',
      '--base-url', 'https://llm.internal.test/v1',
    ], true)
    expectNoPrompt()
  })

  it('init asks no yes or no question', async () => {
    const asked: PromptCall[] = []
    for (const args of [[], ['--platform', 'web'], ['--platform', 'web', '--llm', 'anthropic-compatible']]) {
      vi.clearAllMocks()
      answerWithDefaults()
      await initOk(args, true)
      asked.push(...promptCalls())
    }

    expect(new Set(asked.map(call => call.kind))).toEqual(new Set(['checkbox', 'select', 'input']))
    for (const call of asked) expect(hasDefault(call), `${call.kind} ${call.config.message}`).toBe(true)
  })

  it('init help names --llm with its five values, --model and --base-url', async () => {
    await expect(runInit(['--help'])).rejects.toMatchObject({ code: 'commander.helpDisplayed' })

    const lines = stdout.join('').split('\n')
    const start = lines.findIndex(line => line.startsWith('  --llm <provider>'))
    expect(start).toBeGreaterThanOrEqual(0)
    const next = lines.findIndex((line, index) => index > start && /^\s{2}-/u.test(line))
    const entry = lines.slice(start, next).join(' ')
    for (const value of INIT_LLM_CHOICES) expect(entry).toContain(`"${value}"`)
    expect(entry).toContain('default: claude-code')
    expect(lines.some(line => line.startsWith('  --model <id>'))).toBe(true)
    expect(lines.some(line => line.startsWith('  --base-url <url>'))).toBe(true)
    expect(stdout.join('')).not.toMatch(/--(api-key|token|key|secret)\b/u)
  })
})

describe('C445-MODEL-DEFAULTS', () => {
  it('--llm codex with no --model writes gpt-6.1-sol', async () => {
    await initOk(['--platform', 'web', '--llm', 'codex'])

    expect(writtenConfig().registry.llms).toEqual([
      { name: 'codex', provider: 'openai-subscription', model: 'gpt-6.1-sol' },
    ])
  })

  it('--llm claude-code with no --model writes claude-sonnet-5-5', async () => {
    await initOk(['--platform', 'web', '--llm', 'claude-code'])

    expect(writtenConfig().registry.llms).toEqual([
      { name: 'claude-code', provider: 'anthropic-subscription', model: 'claude-sonnet-5-5' },
    ])
  })

  it('the CLI subscription defaults equal the provider registry defaults', () => {
    expect(DEFAULT_OPENAI_MODEL).toBe(getProvider('openai-subscription')?.defaultModel)
    expect(DEFAULT_ANTHROPIC_MODEL).toBe(getProvider('anthropic-subscription')?.defaultModel)
    expect([DEFAULT_OPENAI_MODEL, DEFAULT_ANTHROPIC_MODEL])
      .toEqual(['gpt-6.1-sol', 'claude-sonnet-5-5'])
  })
})

const GETTING_STARTED = 'https://vostride.com/docs/agent-qa/quickstart'
const RUN_EXAMPLES = 'npx agent-qa run suites/examples.suite.yaml'

function printed(): string {
  return vi.mocked(console.log).mock.calls
    .map(call => call.map(String).join(' '))
    .join('\n')
    .replace(/\u001b\[[0-9;]*m/gu, '')
}

function lineWith(output: string, text: string): string {
  const line = output.split('\n').find(entry => entry.includes(text))
  expect(line, `init printed ${text}`).toBeDefined()
  return line!
}

describe('C445-NEXT-STEPS', () => {
  it('the next steps follow the route order for a subscription workspace', async () => {
    await initOk(['--platform', 'web', '--llm', 'codex'])

    const output = printed()
    const order = [
      'npx agent-qa install-browsers --chromium',
      `npm install -D ${SUBSCRIPTION_AUTH_PACKAGE}`,
      'npx agent-qa auth login --config codex',
      'npx agent-qa validate',
      RUN_EXAMPLES,
      GETTING_STARTED,
    ]
    const positions = order.map(text => output.indexOf(text))
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
    await initOk(['--platform', 'web', '--llm', 'anthropic-compatible'])

    const output = printed()
    const apiKey = lineWith(output, 'npx agent-qa auth set --config default --type api-key')
    expect(apiKey).toContain('hidden prompt')
    lineWith(output, 'npx agent-qa auth set --config default --type bearer-token')
    expect(output.indexOf('npx agent-qa install-browsers --chromium'))
      .toBeLessThan(output.indexOf('npx agent-qa auth set'))
    expect(output.indexOf('npx agent-qa auth set'))
      .toBeLessThan(output.indexOf('npx agent-qa validate'))
    expect(output).not.toContain('auth login')
    expect(output).not.toContain(SUBSCRIPTION_AUTH_PACKAGE)
  })

  it('the next steps name no file init replaces and no dashboard sign-in', async () => {
    const workspaces = [
      ['--platform', 'web', '--llm', 'codex'],
      ['--platform', 'web'],
      ['--platform', 'web', '--llm', 'anthropic-compatible'],
      ['--platform', 'android'],
    ]
    for (const args of workspaces) {
      vi.clearAllMocks()
      await initOk(args)

      const lines = printed().split('\n')
      const start = lines.findIndex(line => line.includes('Next steps:'))
      expect(start, args.join(' ')).toBeGreaterThanOrEqual(0)
      const validate = lines.slice(start).some(line => line.includes('npx agent-qa validate'))
      expect(validate, args.join(' ')).toBe(true)
    }
  })
})
