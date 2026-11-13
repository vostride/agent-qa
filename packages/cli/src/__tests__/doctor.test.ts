import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { resolve } from 'node:path'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

// Spreads the real module: knowledge-local's durable-fs layer needs functions not mocked here.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFile: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
  }
})

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(() => Promise.reject({ code: 'ENOENT' })),
}))

// Doctor imports `checkDockerAvailable` from runner-local.
vi.mock('@vostride/agent-qa-runner-local', () => ({
  checkDockerAvailable: vi.fn(() => Promise.resolve(true)),
}))

// The fold and `indexDbPath` stay real, so doctor and the runner cannot disagree on the rung word.
const knowledgeProbeStubs = vi.hoisted(() => ({
  classifyIndexFace: vi.fn<() => import('@vostride/agent-qa-agent-local').IndexFace>(
    () => ({ source: 'index' }),
  ),
  resolveEmbedderCapability: vi.fn(),
  readWriterLease: vi.fn(() => ({ kind: 'absent' as const })),
  readEmbedderWorkerRegistration: vi.fn(() => ({ kind: 'absent' as const })),
}))

// doctor asks `hooks.daemon` for the daemon; the real module needs the agent-local mocked below.
vi.mock('../daemon/registration.js', () => ({}))

vi.mock('@vostride/agent-qa-agent-local', async () => {
  const knowledge = await vi.importActual<typeof import('@vostride/agent-qa-knowledge-local')>(
    '@vostride/agent-qa-knowledge-local',
  )
  return {
    LOCAL_KNOWLEDGE_PROBES: {
      foldRetrievalRung: knowledge.foldRetrievalRung,
      indexDbPath: knowledge.indexDbPath,
      ...knowledgeProbeStubs,
    },
  }
})

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    AgentQaConfigSchema: {
      safeParse: vi.fn((config: any) => {
        if (config?.workspace && typeof config.workspace.secretsFile !== 'string') {
          return {
            success: false,
            error: { issues: [{ path: ['workspace', 'secretsFile'], message: 'Invalid input: expected string' }] },
          }
        }
        return { success: true, data: config }
      }),
    },
    getCredential: vi.fn(() => null),
    resolveLLMAuth: vi.fn(() => Promise.resolve({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })),
    loadLLMAuthPlugins: vi.fn(() => Promise.resolve()),
    readAuth: vi.fn(() => ({})),
    validateProject: vi.fn(() => Promise.resolve({ errorCount: 0, warningCount: 0, fileCount: 5, results: [] })),
    resolveWorkspacePaths: vi.fn(({ config, configPath }: any) => {
      const configDir = String(configPath).includes('/')
        ? String(configPath).split('/').slice(0, -1).join('/')
        : process.cwd()
      for (const key of ['testMatch', 'suiteMatch', 'hooksFile', 'envFile', 'secretsFile']) {
        if (config.workspace?.[key] === undefined) {
          throw new Error(`Missing required workspace config key: workspace.${key}`)
        }
      }
      const resolveConfigured = (value: string) => value.startsWith('/') ? value : `${configDir}/${value}`
      return {
        configPath,
        configDir,
        testMatch: config.workspace.testMatch,
        suiteMatch: config.workspace.suiteMatch,
        testPathIgnore: config.workspace.testPathIgnore ?? [],
        hooksFile: {
          configuredPath: config.workspace.hooksFile,
          absolutePath: resolveConfigured(config.workspace.hooksFile),
          workspaceRelativePath: config.workspace.hooksFile,
        },
        envFile: {
          configuredPath: config.workspace.envFile,
          absolutePath: resolveConfigured(config.workspace.envFile),
          workspaceRelativePath: config.workspace.envFile,
        },
        secretsFile: {
          configuredPath: config.workspace.secretsFile,
          absolutePath: resolveConfigured(config.workspace.secretsFile),
          workspaceRelativePath: config.workspace.secretsFile,
        },
      }
    }),
    discoverWorkspaceFiles: vi.fn(({ kind }: any) => Promise.resolve(
      kind === 'suite'
        ? [{ kind, absolutePath: `${process.cwd()}/suites/smoke.suite.yaml`, workspaceRelativePath: 'suites/smoke.suite.yaml' }]
        : [{ kind, absolutePath: `${process.cwd()}/tests/login.yaml`, workspaceRelativePath: 'tests/login.yaml' }],
    )),
  }
})

vi.mock('@vostride/agent-qa-model', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-model')>('@vostride/agent-qa-model')
  return {
    ...actual,
    createModel: vi.fn(() => ({})),
  }
})

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
  }
})

vi.mock('../provider-plugins.js', () => ({
  loadProviderPluginsForRawConfig: vi.fn(() => Promise.resolve()),
}))

// Capture console output
const consoleLogs: string[] = []
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  consoleLogs.push(args.map(String).join(' '))
})

import pc from 'picocolors'
import {
  CONFIG_UNCHECKED_FIX,
  DISCOVERY_UNCHECKED_FIX,
  VALIDATE_WARNINGS_FIX,
  checkSubscriptionAuth,
  createDoctorCommand,
  type CheckStatus,
  type DoctorCommandHooks,
} from '../commands/doctor.js'
import {
  DEFAULT_TERMINAL_WIDTH,
  IDENTITY_DECORATION,
  MIN_USABLE_WIDTH,
  composeRow,
  formatCheckRow,
  formatFixLines,
  formatStatus,
  resolveTerminalWidth,
  type CheckRow,
} from '../commands/doctor-row.js'
import { EMBEDDER_FLOOR_FIX, EMBEDDER_NONE_FIX } from '../commands/doctor-knowledge-checks.js'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { DEFAULT_EMBEDDING_PROFILE } from '@vostride/agent-qa-schema'
import * as core from '@vostride/agent-qa-core'
import { clearProviderRegistry, createModel, registerProvider } from '@vostride/agent-qa-model'
import { APICallError, generateText, RetryError } from 'ai'
import { loadProviderPluginsForRawConfig } from '../provider-plugins.js'
import type { ChromiumAnswer, ChromiumResolver } from '../commands/browser-resolver.js'
import { resolveLLMModels } from '../llm-utils.js'

const mockExecSync = vi.mocked(execSync)
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)
const mockReadFile = vi.mocked(readFile)
const mockCreateModel = vi.mocked(createModel)
const mockGetCredential = vi.mocked(core.getCredential)
const mockLoadLLMAuthPlugins = vi.mocked(core.loadLLMAuthPlugins)
const mockLoadProviderPluginsForRawConfig = vi.mocked(loadProviderPluginsForRawConfig)
const mockResolveLLMAuth = vi.mocked((core as any).resolveLLMAuth) as any
const mockGenerateText = vi.mocked(generateText)

const GEMINI_QUOTA_429 = new APICallError({
  message:
    'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 5, model: gemini-2.5-pro',
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
  requestBodyValues: {},
  statusCode: 429,
})

const CHROMIUM_FOUND: ChromiumAnswer = { found: true, path: '/browsers/chromium-1/chrome' }
let chromiumAnswer: ChromiumAnswer = CHROMIUM_FOUND
const chromium = vi.fn<ChromiumResolver>(() => chromiumAnswer)
const daemon = vi.fn<NonNullable<DoctorCommandHooks['daemon']>>(
  () => Promise.resolve({ kind: 'absent' }),
)
// No phone, emulator or simulator here.
const listDevicesHere = vi.fn<NonNullable<DoctorCommandHooks['listDevicesHere']>>(
  async (platform) => (platform === 'android' ? { attached: [], avds: [] } : { simulators: [] }),
)

afterEach(() => {
  chromiumAnswer = CHROMIUM_FOUND
})

const latestVersion: NonNullable<DoctorCommandHooks['latestVersion']> = async () => ({
  source: 'none',
})

// node:fs is mocked here, so the setup rows read a project with no package.json and nothing installed.
const NO_PROJECT_HOST: NonNullable<DoctorCommandHooks['host']> = {
  homedir: '/home/doctor',
  env: {},
  io: {
    exists: () => false,
    readText: () => undefined,
    realpath: async (path) => path,
  },
}

const NO_PROJECT_AUTH_PATH = '/home/doctor/.agent-qa/auth.json'

async function runDoctor(parentConfig?: string, ...args: string[]): Promise<void> {
  consoleLogs.length = 0
  process.exitCode = 0

  const parent = new Command()
  if (parentConfig) parent.setOptionValue('config', parentConfig)
  parent.addCommand(createDoctorCommand({ chromium, daemon, latestVersion, listDevicesHere, host: NO_PROJECT_HOST }))
  await parent.parseAsync(['node', 'test', 'doctor', ...args])
}

function getOutput(): string {
  return consoleLogs.join('\n')
}

/** No doctor row reads the port; only the profile's model id reaches the terminal. */
const NATIVE_READY = {
  kind: 'ready',
  rung: 'native',
  profile: DEFAULT_EMBEDDING_PROFILE,
  embedder: {},
} as never

/** The three knowledge rows between legacy memory and config validation. */
const KNOWLEDGE_ROW_NAMES = ['Knowledge store', 'Embedder', 'Retrieval rung'] as const

const ESC = String.fromCharCode(27)
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '')

// The emit loop's fix line, at six spaces, deeper than a row's four.
const FIX_LINE_PATTERN = /^ {6}Fix: /
// A message line moved beneath its row, at the same six-space indent.
const CONTINUATION_PATTERN = /^ {6}\S/

// Strings measured on the built cli, transcribed so the cells can pin the widths.
const MEASURED_INDEX_PATH = 'agent-qa-knowledge/memory/index/knowledge.db'
const MEASURED_FAIL_MESSAGE = `index at ${MEASURED_INDEX_PATH} could not be opened: corrupt`
const MEASURED_FIX_INSTRUCTIONS =
  'Rebuild the index with `npx agent-qa knowledge rebuild-index`, or remove the corrupt file at '
  + `${MEASURED_INDEX_PATH} and re-run.`

// The one-line row template (`padDots` to 60 columns), written out so the bytes are visible.
function preChangeRow(name: string, message: string, statusWord: string): string {
  const dots = '.'.repeat(Math.max(2, 60 - (name.length + message.length)))
  return `    ${name}  ${dots}  ${message}  ${statusWord}`
}

// Wide enough for every row here to fit one line, and fixed so the host's terminal decides nothing.
const WIDE_TEST_WIDTH = 200

const ORIGINAL_STDOUT_COLUMNS = Object.getOwnPropertyDescriptor(process.stdout, 'columns')

function setStdoutColumns(value: number | undefined): void {
  Object.defineProperty(process.stdout, 'columns', { value, configurable: true, writable: true })
}

/** Resolve to exactly this width: stdout wins over COLUMNS, so clear COLUMNS as well. */
function forceTerminalWidth(width: number): void {
  setStdoutColumns(width)
  delete process.env.COLUMNS
}

function restoreTerminalWidth(): void {
  if (ORIGINAL_STDOUT_COLUMNS) {
    Object.defineProperty(process.stdout, 'columns', ORIGINAL_STDOUT_COLUMNS)
  } else {
    setStdoutColumns(undefined)
  }
}

// A `Fix:` line ends the row before the indent test, because the fix line also sits at six spaces.
function rowFor(name: string): string {
  const lines = consoleLogs.map(stripAnsi)
  const start = lines.findIndex(line => line.startsWith(`    ${name}  `))
  if (start < 0) return ''

  const parts: string[] = [lines[start] ?? '']
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (FIX_LINE_PATTERN.test(line)) break
    if (!CONTINUATION_PATTERN.test(line)) break
    parts.push(line.trim())
  }
  return parts.join(' ')
}

// Every file a healthy host needs is present, and no retired v1 memory folder is left behind.
function presentExceptLegacyMemory(): void {
  mockExistsSync.mockImplementation(path => !String(path).endsWith('agent-qa-memory'))
}

// The fix printed beneath a row, joined across its hanging lines; empty when none prints.
function fixUnder(name: string): string {
  const lines = consoleLogs.map(stripAnsi)
  const start = lines.findIndex(line => line.startsWith(`    ${name}  `))
  if (start < 0) return ''
  let index = start + 1
  while (!FIX_LINE_PATTERN.test(lines[index] ?? '') && CONTINUATION_PATTERN.test(lines[index] ?? '')) {
    index += 1
  }
  if (!FIX_LINE_PATTERN.test(lines[index] ?? '')) return ''
  const parts = [(lines[index] ?? '').replace(FIX_LINE_PATTERN, '')]
  for (index += 1; /^ {11}\S/.test(lines[index] ?? ''); index += 1) parts.push((lines[index] ?? '').trim())
  return parts.join(' ')
}

describe('doctor command', () => {
  const originalVersion = process.version
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogs.length = 0
    process.exitCode = 0
    mockExistsSync.mockReturnValue(false)
    mockReadFile.mockRejectedValue({ code: 'ENOENT' })
    mockLoadLLMAuthPlugins.mockResolvedValue([])
    mockLoadProviderPluginsForRawConfig.mockResolvedValue()
    mockReadFileSync.mockReturnValue('')
    // A healthy knowledge substrate is the default; each knowledge cell moves only its own axis.
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({ source: 'index' })
    knowledgeProbeStubs.resolveEmbedderCapability.mockResolvedValue(NATIVE_READY)
    knowledgeProbeStubs.readWriterLease.mockReturnValue({ kind: 'absent' })
    knowledgeProbeStubs.readEmbedderWorkerRegistration.mockReturnValue({ kind: 'absent' })
    // Pins the width every command-level cell renders at, so the host's terminal decides nothing.
    forceTerminalWidth(WIDE_TEST_WIDTH)
    // Clean env for consistent tests
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_KEY
    delete process.env.ANDROID_HOME
    delete process.env.ANDROID_SDK_ROOT
  })

  afterEach(() => {
    clearProviderRegistry()
    Object.defineProperty(process, 'version', { value: originalVersion, writable: true })
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
    restoreTerminalWidth()
  })

  it('Node.js version check passes for v24+', async () => {
    Object.defineProperty(process, 'version', { value: 'v24.10.0', writable: true })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('v24.10.0')
    expect(output).toContain('PASS')
  })

  it('Node.js version check fails for v18', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.20.0', writable: true })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('requires Node.js 24 or newer')
    expect(output).toContain('FAIL')
  })

  it('Config file check passes when file exists', async () => {
    mockExistsSync.mockImplementation((p) => {
      return (p as string).endsWith('agent-qa.config.yaml')
    })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('agent-qa.config.yaml found')
    expect(output).toContain('PASS')
  })

  it('Config file check warns when missing', async () => {
    mockExistsSync.mockReturnValue(false)

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('not found')
    expect(output).toContain('WARN')
    expect(fixUnder('Config file')).toContain('`npx agent-qa init`')
  })

  it('warns with the resolved path when legacy v1 memory data exists', async () => {
    const configPath = resolve(process.cwd(), 'fixture', 'agent-qa.config.yaml')
    const legacyMemoryDir = resolve(process.cwd(), 'fixture', 'agent-qa-memory')
    mockExistsSync.mockImplementation(path => path === legacyMemoryDir)
    const warning = `v1 memory data found at ${legacyMemoryDir} — no longer used by agent-qa; safe to delete`
    forceTerminalWidth(warning.length + 120)

    await runDoctor(configPath)

    expect(getOutput()).toContain(warning)
    expect(getOutput()).toContain('WARN')
  })

  it('passes the legacy v1 memory check without modifying an absent directory', async () => {
    const configPath = resolve(process.cwd(), 'fixture', 'agent-qa.config.yaml')
    const legacyMemoryDir = resolve(process.cwd(), 'fixture', 'agent-qa-memory')
    mockExistsSync.mockReturnValue(false)

    await runDoctor(configPath)

    expect(getOutput()).toContain(`no v1 memory data found at ${legacyMemoryDir}`)
    expect(mockExistsSync).toHaveBeenCalledWith(legacyMemoryDir)
  })

  it('looks up no model credential when config is missing', async () => {
    await runDoctor()

    expect(mockResolveLLMAuth).not.toHaveBeenCalled()
  })

  it('uses the parent global config path when loading config', async () => {
    mockExistsSync.mockImplementation((p) => p === 'custom-agent-qa.yaml')
    mockReadFile.mockResolvedValue(`
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
` as never)

    await runDoctor('custom-agent-qa.yaml')

    expect(mockExistsSync).toHaveBeenCalledWith('custom-agent-qa.yaml')
    expect(mockReadFile).toHaveBeenCalledWith('custom-agent-qa.yaml', 'utf-8')
  })

  it('passes the secrets file check when workspace.secretsFile exists', async () => {
    mockReadFile.mockResolvedValue(`
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .secrets.local
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
` as never)
    mockExistsSync.mockImplementation((p) => String(p).endsWith('.secrets.local'))

    await runDoctor()

    const output = getOutput()
    expect(output).toContain('Secrets file')
    expect(output).toContain('.secrets.local found')
  })

  it('fails the secrets file check when workspace.secretsFile is missing', async () => {
    mockReadFile.mockResolvedValue(`
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
` as never)

    await runDoctor()

    const output = getOutput()
    expect(output).toContain('Missing required workspace config key: workspace.secretsFile')
    expect(fixUnder('Secrets file')).toContain('Set the workspace key the message names')
    expect(fixUnder('Secrets file')).toContain('`npx agent-qa init --setup scaffold`')
  })

  it('LLM credential checks resolve by config name without env-var fallback output', async () => {
    const compatibleConfig = `
registry:
  llms:
    - name: planner
      provider: anthropic-compatible
      model: claude-remote
      baseURL: https://remote.example/messages
use:
  llm: planner
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    await runDoctor()
    const output = getOutput()

    expect(mockResolveLLMAuth).toHaveBeenCalledWith('planner', expect.objectContaining({
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://remote.example/messages',
    }), NO_PROJECT_AUTH_PATH, 'agent-qa.config.yaml')
    expect(output).not.toContain('ANTHROPIC_API_KEY')
    expect(output).not.toContain('OPENAI_API_KEY')
    expect(output).not.toContain('GOOGLE_GENERATIVE_AI_KEY')
  })

  it('Gemini missing credentials use resolver message without Google env-var guidance', async () => {
    const geminiConfig = `
registry:
  llms:
    - name: gemini-fast
      provider: gemini
      model: gemini-3-flash-preview
use:
  llm: gemini-fast
`
    mockReadFile.mockResolvedValue(geminiConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'gemini-fast',
      provider: 'gemini',
      required: true,
      message: 'Save a Gemini API key for this config before testing.',
    })

    await runDoctor()
    const output = getOutput()

    expect(output).toContain('Save a Gemini API key for this config before testing.')
    expect(output).not.toContain('GOOGLE_GENERATIVE_AI_KEY')
    expect(output).not.toContain('OPENAI_API_KEY')
    expect(output).not.toContain('ANTHROPIC_API_KEY')
  })

  it('openai-compatible checks use exact baseURL and allow resolver unauthenticated state', async () => {
    const compatibleConfig = `
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
    mockCreateModel.mockReturnValue({} as any)
    mockGenerateText.mockResolvedValue({ text: 'ok' } as any)

    await runDoctor()

    const output = getOutput()
    expect(output).toContain('Testing without a saved credential.')
    expect(output).toContain('credential optional')
    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'deepseek-chat',
        baseURL: 'https://remote.example/api/v1',
        auth: { mode: 'none' },
      }),
      { kind: 'none' },
      expect.any(Function),
    )
    expect(mockGetCredential).not.toHaveBeenCalled()
  })

  it('LLM connection passes resolver auth material and providerHeaders to createModel', async () => {
    const compatibleConfig = `
registry:
  llms:
    - name: planner
      provider: anthropic-compatible
      model: claude-remote
      baseURL: https://remote.example/messages
      providerHeaders:
        x-workspace: agent-qa
use:
  llm: planner
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'bearer-token',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      token: 'bearer-planner',
    })

    await runDoctor()

    expect(mockResolveLLMAuth).toHaveBeenCalledWith('planner', expect.objectContaining({
      provider: 'anthropic-compatible',
      providerHeaders: { 'x-workspace': 'agent-qa' },
    }), NO_PROJECT_AUTH_PATH, 'agent-qa.config.yaml')
    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://remote.example/messages',
        headers: { 'x-workspace': 'agent-qa' },
        auth: { mode: 'bearer-token' },
      }),
      { kind: 'bearer-token', token: 'bearer-planner' },
      expect.any(Function),
    )
  })

  it('loads declared auth plugins and forwards auth-fetch modelAdapter to createModel', async () => {
    const subscriptionConfig = `
plugins:
  - name: subscription
    package: "@vostride/agent-qa-subscription-auth"
  - name: provider
    path: ./providers/sixth-provider.js
registry:
  llms:
    - name: codex
      provider: openai-subscription
      model: gpt-5.5
use:
  llm: codex
`
    const authFetch = vi.fn() as unknown as typeof globalThis.fetch
    mockReadFile.mockResolvedValue(subscriptionConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'auth-fetch',
      credentialKey: 'codex',
      provider: 'openai-subscription',
      modelAdapter: 'openai-responses',
      fetch: authFetch,
    })

    await runDoctor('agent-qa.config.yaml')

    const entries = [
      { name: 'subscription', package: '@vostride/agent-qa-subscription-auth' },
      { name: 'provider', path: './providers/sixth-provider.js' },
    ]
    expect(mockLoadLLMAuthPlugins).toHaveBeenCalledWith(
      entries,
      expect.objectContaining({ baseDir: expect.any(String) }),
    )
    expect(mockLoadProviderPluginsForRawConfig).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: entries }),
      'agent-qa.config.yaml',
    )
    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-subscription',
        model: 'gpt-5.5',
        auth: { mode: 'subscription', plugin: 'openai-subscription' },
      }),
      { kind: 'auth-fetch', fetch: authFetch, modelAdapter: 'openai-responses' },
      expect.any(Function),
    )
  })

  it('classifies a registered sixth provider as subscription through registry metadata', async () => {
    registerProvider({
      id: 'sixth-subscription',
      label: 'Sixth Subscription',
      adapter: () => ({} as any),
      needsBaseURL: false,
      authModes: ['subscription'],
      subscription: true,
    })
    const subscriptionConfig = `
registry:
  llms:
    - name: sixth
      provider: sixth-subscription
      model: hosted-sixth
use:
  llm: sixth
`
    const authFetch = vi.fn() as unknown as typeof globalThis.fetch
    mockReadFile.mockResolvedValue(subscriptionConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'auth-fetch',
      credentialKey: 'sixth',
      provider: 'sixth-subscription',
      modelAdapter: 'openai-responses',
      fetch: authFetch,
    })

    await runDoctor()

    const output = getOutput()
    expect(output).not.toContain('subscription not used for sixth-subscription')
    expect(output).toContain('OAuth connected')
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('sixth', expect.objectContaining({
      provider: 'sixth-subscription',
      model: 'hosted-sixth',
    }), NO_PROJECT_AUTH_PATH, 'agent-qa.config.yaml')
  })

  it('classifies a registered sixth provider as requiring baseURL through registry metadata', async () => {
    registerProvider({
      id: 'sixth-compatible',
      label: 'Sixth Compatible',
      adapter: () => ({} as any),
      needsBaseURL: true,
      authModes: ['api-key'],
    })
    const compatibleConfig = `
registry:
  llms:
    - name: sixth
      provider: sixth-compatible
      model: hosted-sixth
use:
  llm: sixth
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)

    await runDoctor()

    expect(getOutput()).toContain('baseURL required for sixth-compatible')
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('openai-compatible connection check fails when baseURL is missing', async () => {
    const compatibleConfig = `
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
use:
  llm: planner
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)
    mockGetCredential.mockResolvedValue(null)

    await runDoctor()

    expect(getOutput()).toContain('baseURL required for openai-compatible')
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('Playwright passes with Chromium found when the resolver finds it', async () => {
    await runDoctor()

    expect(rowFor('Playwright')).toMatch(/ Chromium found {2}PASS$/)
    expect(fixUnder('Playwright')).toBe('')
  })

  it('Playwright fails with the install-browsers fix when the resolver finds no Chromium', async () => {
    chromiumAnswer = { found: false, reason: 'no file at /browsers/chromium-1/chrome' }

    await runDoctor()

    expect(rowFor('Playwright')).toMatch(/ no Chromium for agent-qa's Playwright {2}FAIL$/)
    expect(fixUnder('Playwright')).toBe('Run `npx agent-qa install-browsers --chromium`')
  })

  it('Playwright skips a project with no web target without asking the resolver', async () => {
    mockReadFile.mockResolvedValue(`
registry:
  targets:
    my-app:
      platform: android
` as never)

    await runDoctor()

    expect(rowFor('Playwright')).toMatch(/ not configured {2}SKIP$/)
    expect(chromium).not.toHaveBeenCalled()
  })

  it('doctor asks the resolver and runs no npx playwright command', async () => {
    await runDoctor()

    expect(chromium).toHaveBeenCalledTimes(1)
    expect(mockExecSync.mock.calls.map(([command]) => String(command))).not.toContainEqual(
      expect.stringContaining('playwright'),
    )
  })

  it('Android SDK check validates ANDROID_HOME', async () => {
    const mobileConfig = `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
use:
  llm: default
targets:
  my-app:
    platform: android
`
    mockReadFile.mockResolvedValue(mobileConfig as never)
    process.env.ANDROID_HOME = '/opt/android-sdk'
    mockExistsSync.mockImplementation((p) => {
      return (p as string).includes('platform-tools/adb')
    })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('SDK found')
  })

  it('Xcode check skipped on non-macOS', async () => {
    const mobileConfig = `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
use:
  llm: default
targets:
  my-app:
    platform: ios
`
    mockReadFile.mockResolvedValue(mobileConfig as never)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('requires macOS')
  })

  describe('the Xcode row', () => {
    const iosConfig = `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
use:
  llm: default
targets:
  my-app:
    platform: ios
`

    it('lists the simulators with a 10 s bound', async () => {
      mockReadFile.mockResolvedValue(iosConfig as never)
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      mockExecSync.mockReturnValue(Buffer.from('== Devices =='))

      await runDoctor()

      expect(mockExecSync).toHaveBeenCalledWith(
        'xcrun simctl list',
        expect.objectContaining({ timeout: 10_000 }),
      )
      expect(rowFor('Xcode')).toMatch(/simctl available {2}PASS$/)
    })

    it('fails with how long it waited when the simulator listing does not answer in time', async () => {
      mockReadFile.mockResolvedValue(iosConfig as never)
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      mockExecSync.mockImplementation((command) => {
        if (command === 'xcrun simctl list') {
          throw Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT' })
        }
        return Buffer.from('')
      })

      await runDoctor()

      expect(rowFor('Xcode')).toMatch(/xcrun simctl did not answer within 10 s {2}FAIL$/)
    })
  })

  describe('mobile tool rows and remote devices', () => {
    function deviceConfig(targets: string[], devices: string): string {
      return `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
  remotes:
    - name: farm
      protocol: appium
      url: https://farm.example/wd/hub
  targets:
${targets.map((platform) => `    ${platform}-app:\n      platform: ${platform}`).join('\n')}
${devices}
use:
  llm: default
`
    }

    // A Linux host with no Android SDK and no Xcode; the farm never answers.
    function bareLinuxHost(): void {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      mockExecSync.mockImplementation(() => {
        throw new Error('not found')
      })
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function statusOf(name: string): string | undefined {
      return /(PASS|WARN|FAIL|SKIP)$/.exec(stripAnsi(rowFor(name)))?.[1]
    }

    it('skips the Android SDK and Xcode when every device is remote', async () => {
      mockReadFile.mockResolvedValue(
        deviceConfig(
          ['android', 'ios'],
          `  devices:
    pixel:
      platform: android
      remote: farm
    iphone:
      platform: ios
      remote: farm`,
        ) as never,
      )
      bareLinuxHost()

      await runDoctor()

      expect(rowFor('Android SDK')).toMatch(/every android device is remote {2}SKIP$/)
      expect(rowFor('Xcode')).toMatch(/every iOS device is remote {2}SKIP$/)
      expect(statusOf('Remote farm')).toBe('WARN')
      for (const name of ['Android SDK', 'Xcode', 'Remote farm']) {
        expect(statusOf(name)).not.toBe('FAIL')
      }
    })

    it('keeps the Android SDK row when one android device runs here', async () => {
      mockReadFile.mockResolvedValue(
        deviceConfig(
          ['android', 'ios'],
          `  devices:
    pixel:
      platform: android
    iphone:
      platform: ios
      remote: farm`,
        ) as never,
      )
      bareLinuxHost()

      await runDoctor()

      expect(rowFor('Android SDK')).toMatch(/ANDROID_HOME not set {2}FAIL$/)
      expect(rowFor('Xcode')).toMatch(/every iOS device is remote {2}SKIP$/)
    })

    it('keeps every mobile row when the config lists no devices', async () => {
      mockReadFile.mockResolvedValue(deviceConfig(['android', 'ios'], '') as never)
      bareLinuxHost()

      await runDoctor()

      expect(rowFor('Android SDK')).toMatch(/ANDROID_HOME not set {2}FAIL$/)
      expect(rowFor('Xcode')).toMatch(/iOS testing requires macOS {2}FAIL$/)
    })

    it('checks Xcode for an iOS target when only android devices are listed and all are remote', async () => {
      const androidDevice = `  devices:
    pixel:
      platform: android
      remote: farm`
      bareLinuxHost()

      mockReadFile.mockResolvedValue(deviceConfig(['android', 'ios'], androidDevice) as never)
      await runDoctor()
      expect(rowFor('Android SDK')).toMatch(/every android device is remote {2}SKIP$/)
      expect(rowFor('Xcode')).toMatch(/iOS testing requires macOS {2}FAIL$/)

      mockReadFile.mockResolvedValue(deviceConfig(['android'], androidDevice) as never)
      await runDoctor()
      expect(rowFor('Xcode')).toMatch(/not configured {2}SKIP$/)
    })
  })

  it('Overall result: all pass → exit 0', async () => {
    Object.defineProperty(process, 'version', { value: 'v24.10.0', writable: true })
    presentExceptLegacyMemory()
    mockExecSync.mockReturnValue(Buffer.from('ok'))
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'default',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
    // Provide a valid config so config validation passes
    const { stringify } = await import('yaml')
    const validConfig = stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.secrets.local',
      },
      registry: { llms: [{ name: 'default', provider: 'openai-compatible', model: 'model-name', baseURL: 'https://remote.example/api/v1' }] },
      services: { cache: { dir: '.agent-qa/cache' }, logging: { level: 'warn' }, vision: { screenshotSize: '1m' } },
      use: {
        browser: { name: 'chromium', headless: true },
        timeout: { step: '30s', test: '10m', navigation: '10s' },
        healing: { maxAttempts: 3 },
        planner: { maxActions: 50, maxPlanningTurns: 50, previousStepCount: 5 },
        llm: 'default',
      },
    })
    mockReadFile.mockResolvedValue(validConfig as never)

    await runDoctor()
    expect(process.exitCode).toBe(0)
    const output = getOutput()
    expect(output).toContain('All checks passed')
  })

  it('exits 3 when a row fails', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.0.0', writable: true })

    await runDoctor()
    expect(process.exitCode).toBe(3)
    const output = getOutput()
    expect(output).toContain('Some checks failed. See fix instructions above.')
  })

  it('exits 3 from doctor --json when a row fails', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.0.0', writable: true })

    await runDoctor(undefined, '--json')
    const document = JSON.parse(getOutput())
    expect(document.ok).toBe(false)
    expect(process.exitCode).toBe(3)
  })

  it('Fix instructions printed for each failure', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.0.0', writable: true })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('Install Node.js 24 or newer')
  })

  async function runHealthyHost(...args: string[]): Promise<void> {
    Object.defineProperty(process, 'version', { value: 'v24.10.0', writable: true })
    presentExceptLegacyMemory()
    mockExecSync.mockReturnValue(Buffer.from('ok'))
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'default',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
    const { stringify } = await import('yaml')
    mockReadFile.mockResolvedValue(stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.secrets.local',
      },
      registry: { llms: [{ name: 'default', provider: 'openai-compatible', model: 'model-name', baseURL: 'https://remote.example/api/v1' }] },
      services: { cache: { dir: '.agent-qa/cache' }, logging: { level: 'warn' }, vision: { screenshotSize: '1m' } },
      use: {
        browser: { name: 'chromium', headless: true },
        timeout: { step: '30s', test: '10m', navigation: '10s' },
        healing: { maxAttempts: 3 },
        planner: { maxActions: 50, maxPlanningTurns: 50, previousStepCount: 5 },
        llm: 'default',
      },
    }) as never)
    await runDoctor(undefined, ...args)
  }

  it('a project with validation errors fails the Validate row with npx agent-qa validate as its fix', async () => {
    vi.mocked(core.validateProject).mockResolvedValueOnce(
      { errorCount: 2, warningCount: 0, fileCount: 5, results: [] } as never,
    )

    await runHealthyHost()

    expect(rowFor('Validate')).toContain('FAIL')
    expect(fixUnder('Validate')).toContain('`npx agent-qa validate`')
  })

  it('a config doctor could not check warns with the command that shows why, not the key fix', async () => {
    vi.mocked(core.AgentQaConfigSchema.safeParse).mockImplementationOnce(() => {
      throw new Error('schema module failed to load')
    })

    await runHealthyHost()

    expect(rowFor('Config validation')).toContain('could not validate config')
    expect(rowFor('Config validation')).toContain('WARN')
    expect(fixUnder('Config validation')).not.toContain('key named above')
    expect(fixUnder('Config validation')).toBe(CONFIG_UNCHECKED_FIX)
  })

  it('a rate-limited model connection warns to wait and test again, not to check the credential', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('429 Too Many Requests: rate limit reached'))

    await runHealthyHost()

    expect(rowFor('LLM connection')).toContain('rate limited — try again later')
    expect(rowFor('LLM connection')).toContain('WARN')
    expect(fixUnder('LLM connection')).not.toContain('Check the saved credential')
    expect(fixUnder('LLM connection')).toContain(
      'Wait, then run `npx agent-qa auth test --config default`',
    )
  })

  it('a 429 whose provider message names the model warns to wait, not that the model is missing', async () => {
    mockGenerateText.mockRejectedValueOnce(GEMINI_QUOTA_429)

    await runHealthyHost()

    expect(rowFor('LLM connection')).toContain('rate limited — try again later')
    expect(rowFor('LLM connection')).toContain('WARN')
    expect(rowFor('LLM connection')).not.toContain('Model not found')
    expect(fixUnder('LLM connection')).toContain(
      'Wait, then run `npx agent-qa auth test --config default`',
    )
  })

  it('a 429 wrapped in a retry error warns to wait, not that the model is missing', async () => {
    mockGenerateText.mockRejectedValueOnce(
      new RetryError({
        message: `Failed after 3 attempts. Last error: ${GEMINI_QUOTA_429.message}`,
        reason: 'maxRetriesExceeded',
        errors: [GEMINI_QUOTA_429, GEMINI_QUOTA_429, GEMINI_QUOTA_429],
      }),
    )

    await runHealthyHost()

    expect(rowFor('LLM connection')).toContain('rate limited — try again later')
    expect(rowFor('LLM connection')).toContain('WARN')
    expect(fixUnder('LLM connection')).toContain(
      'Wait, then run `npx agent-qa auth test --config default`',
    )
  })

  it('a model error that is not a 429 still fails as model not found', async () => {
    mockGenerateText.mockRejectedValueOnce(
      new APICallError({
        message: 'models/gemini-9 is not found for API version v1beta',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-9:generateContent',
        requestBodyValues: {},
        statusCode: 404,
      }),
    )

    await runHealthyHost()

    expect(rowFor('LLM connection')).toContain('Model not found. Check the model name.')
    expect(rowFor('LLM connection')).toContain('FAIL')
    expect(fixUnder('LLM connection')).not.toContain('rate-limiting')
  })

  it('the connection probe does not retry into its own timeout', async () => {
    await runHealthyHost()

    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }))
  })

  it('validation warnings print the command that lists them, not a fix for errors', async () => {
    vi.mocked(core.validateProject).mockResolvedValueOnce(
      { errorCount: 0, warningCount: 2, fileCount: 5, results: [] } as never,
    )

    await runHealthyHost()

    expect(rowFor('Validate')).toContain('2 warning(s)')
    expect(rowFor('Validate')).toContain('WARN')
    expect(fixUnder('Validate')).not.toContain('fix reported errors')
    expect(fixUnder('Validate')).toBe(VALIDATE_WARNINGS_FIX)
  })

  it('a test scan that throws warns with the command that shows why, not the patterns fix', async () => {
    const discover = vi.mocked(core.discoverWorkspaceFiles)
    const scan = discover.getMockImplementation()!
    // Web placement scans first and swallows the error, so every scan in this run throws.
    discover.mockRejectedValue(new Error('EACCES: permission denied'))
    try {
      await runHealthyHost()
    } finally {
      discover.mockImplementation(scan)
    }

    expect(rowFor('Test discovery')).toContain('could not scan for test files')
    expect(rowFor('Test discovery')).toContain('WARN')
    expect(fixUnder('Test discovery')).not.toContain('testMatch')
    expect(fixUnder('Test discovery')).toBe(DISCOVERY_UNCHECKED_FIX)
  })

  it('prints three rows between Legacy v1 memory data and Config validation, store then embedder then rung', async () => {
    await runHealthyHost()

    // Row heads only: a row whose message embeds the checkout path wraps beneath itself where the
    // checkout path is long (a gate clone under /private/var/folders), which shifts raw line indexes.
    const heads = consoleLogs.map(stripAnsi).filter(line => /^ {4}\S/.test(line))
    const indexOf = (name: string): number => heads.findIndex(line => line.startsWith(`    ${name}  `))
    const legacy = indexOf('Legacy v1 memory data')
    const validation = indexOf('Config validation')
    const positions = KNOWLEDGE_ROW_NAMES.map(indexOf)

    expect(legacy).toBeGreaterThanOrEqual(0)
    expect(validation).toBeGreaterThanOrEqual(0)
    expect(positions).toEqual([legacy + 1, legacy + 2, legacy + 3])
    expect(positions[2]).toBeLessThan(validation)
  })

  it('skips all three rows when no knowledge root resolves, and never omits a row', async () => {
    mockExistsSync.mockReturnValue(false)

    await runDoctor()

    for (const name of KNOWLEDGE_ROW_NAMES) {
      expect(rowFor(name)).toContain('no knowledge root configured')
      expect(rowFor(name)).toContain('SKIP')
      expect(rowFor(name)).not.toContain('FAIL')
    }
    // The process exit code is deliberately NOT asserted here: with no config at all the LLM,
    // workspace and validation rows fail on their own account, so an assertion about it would be
    // about them. "Degraded by design still exits 0" is the WARN cell below, on a healthy host.
    expect(getOutput()).not.toContain('Fix: Rebuild the index')
    expect(getOutput()).not.toContain('Fix: v2 does not download the embedding model')
  })

  it('passes the retrieval rows on a healthy host', async () => {
    await runHealthyHost()

    expect(rowFor('Knowledge store')).toContain('index open at')
    expect(rowFor('Embedder')).toContain(`native (${DEFAULT_EMBEDDING_PROFILE.model_id})`)
    expect(rowFor('Retrieval rung')).toContain('memidex')
    for (const name of KNOWLEDGE_ROW_NAMES) expect(rowFor(name)).toContain('PASS')
    expect(process.exitCode).toBe(0)
  })

  it('warns — never fails — a host degraded by design, so a floor install does not red the gate', async () => {
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({
      source: 'scan',
      reason: 'absent',
      detail: 'derived index file is absent',
      filePresent: false,
    })
    knowledgeProbeStubs.resolveEmbedderCapability.mockResolvedValue({
      kind: 'ready',
      rung: 'floor',
      profile: DEFAULT_EMBEDDING_PROFILE,
      embedder: {},
    } as never)

    await runHealthyHost()

    for (const name of KNOWLEDGE_ROW_NAMES) {
      expect(rowFor(name)).toContain('WARN')
      expect(rowFor(name)).not.toContain('FAIL')
    }
    expect(rowFor('Knowledge store')).toContain('scanning bundles')
    expect(rowFor('Embedder')).toContain('static floor — native ONNX runtime unavailable')
    expect(rowFor('Retrieval rung')).toContain('bundle-scan — knowledge index not built yet')
    expect(process.exitCode).toBe(0)
    expect(getOutput()).toContain('No check failed. The warnings above say what to fix.')
    expect(getOutput()).not.toContain('All checks passed')
  })

  function degradeKnowledgeByDesign(): void {
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({
      source: 'scan',
      reason: 'absent',
      detail: 'derived index file is absent',
      filePresent: false,
    })
  }

  it('prints the fix under a WARN row and none under a PASS or SKIP row', async () => {
    degradeKnowledgeByDesign()

    await runHealthyHost()

    expect(rowFor('Knowledge store')).toContain('WARN')
    expect(fixUnder('Knowledge store')).not.toBe('')
    expect(rowFor('Node.js')).toContain('PASS')
    expect(fixUnder('Node.js')).toBe('')
    expect(rowFor('Subscription Auth')).toContain('SKIP')
    expect(fixUnder('Subscription Auth')).toBe('')
  })

  it('prints the same fix under a WARN row as doctor --json gives it', async () => {
    degradeKnowledgeByDesign()
    await runHealthyHost()
    const printed = fixUnder('Knowledge store')

    await runHealthyHost('--json')
    const document = JSON.parse(getOutput())
    const row = document.rows.find((entry: { name: string }) => entry.name === 'Knowledge store')

    expect(row.status).toBe('warn')
    expect(printed).toBe(row.fix.replace(/\s+/gu, ' ').trim())
  })

  it('exits 0 from doctor --json with warnings and no failure', async () => {
    degradeKnowledgeByDesign()

    await runHealthyHost('--json')
    const document = JSON.parse(getOutput())

    expect(document.ok).toBe(true)
    expect(document.rows.some((entry: { status: string }) => entry.status === 'warn')).toBe(true)
    expect(process.exitCode).toBe(0)
  })

  it('prints the plugins add command under the Subscription Auth warning', async () => {
    mockReadFile.mockResolvedValue(
      'registry:\n  llms:\n    - name: claude-code\n      provider: anthropic-subscription\n'
        + '      model: claude-sonnet-4-6\nuse:\n  llm: claude-code\n' as never,
    )
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'claude-code',
      provider: 'anthropic-subscription',
      required: true,
      message: 'Provider "anthropic-subscription" needs the subscription-auth plugin.',
    })

    await runDoctor()

    expect(rowFor('Subscription Auth'), getOutput()).toContain('WARN')
    expect(fixUnder('Subscription Auth'), getOutput()).toContain(
      'npx agent-qa plugins add @vostride/agent-qa-subscription-auth',
    )
  })

  it('fails the store row and exits 3 when the index file is present and will not open', async () => {
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({
      source: 'scan',
      reason: 'corrupt',
      detail: 'SQLITE_NOTADB: file is not a database',
      filePresent: true,
    })

    await runHealthyHost()

    expect(rowFor('Knowledge store')).toContain('could not be opened: corrupt')
    expect(rowFor('Knowledge store')).toContain('FAIL')
    expect(getOutput()).toContain('Fix: Rebuild the index with `npx agent-qa knowledge rebuild-index`')
    expect(rowFor('Retrieval rung')).not.toContain('FAIL')
    expect(process.exitCode).toBe(3)
  })

  it('names the worker profile failure by its cause when a live daemon lease published no worker registration', async () => {
    knowledgeProbeStubs.readWriterLease.mockReturnValue({ kind: 'parsed', lease: {} } as never)
    knowledgeProbeStubs.readEmbedderWorkerRegistration.mockReturnValue({ kind: 'absent' })
    daemon.mockResolvedValueOnce({ kind: 'live', registration: { pid: 4242, startedAtMs: 1_000 } } as never)
    mockReadFileSync.mockImplementation((target) => (
      String(target).endsWith('daemon-events.jsonl')
        ? `${JSON.stringify({
          ts: new Date(2_000).toISOString(),
          kind: 'embedder-worker-exit',
          reason: 'crash',
          stderr: 'Error: Embedder worker could not resolve profile: deferred\n    at /home/u/worker.js',
        })}\n`
        : ''
    ))

    await runHealthyHost()

    expect(rowFor('Embedder')).toContain(
      'daemon embedder worker not registered: could not resolve profile (deferred)',
    )
    expect(rowFor('Embedder')).toContain('FAIL')
    expect(getOutput()).not.toContain('/home/u/worker.js')
    expect(getOutput()).toContain('Fix: v2 does not download the embedding model')
    expect(getOutput()).not.toContain('agent-qa.config.yaml (the daemon')
  })

  it('an idle daemon whose embedder worker has not started passes the Embedder row and doctor exits 0', async () => {
    knowledgeProbeStubs.readWriterLease.mockReturnValue({ kind: 'parsed', lease: {} } as never)
    knowledgeProbeStubs.readEmbedderWorkerRegistration.mockReturnValue({ kind: 'absent' })
    daemon.mockResolvedValueOnce({ kind: 'live', registration: { pid: 4242, startedAtMs: 1_000 } } as never)

    await runHealthyHost()

    expect(rowFor('Embedder')).toContain('PASS')
    expect(rowFor('Embedder')).toContain('when a run needs it')
    expect(rowFor('Embedder')).not.toContain('FAIL')
    expect(process.exitCode).toBe(0)
  })

  it("prints the Embedder WARN's own fix in the table and in doctor --json for a fresh project with no daemon", async () => {
    knowledgeProbeStubs.resolveEmbedderCapability.mockResolvedValue({
      kind: 'deferred',
      reason: 'cold-artifact',
    })

    await runHealthyHost()

    expect(rowFor('Embedder')).toContain('none — embedding model not downloaded')
    expect(rowFor('Embedder')).toContain('WARN')
    expect(fixUnder('Embedder')).not.toContain('exited with an error')
    expect(fixUnder('Embedder')).toBe(EMBEDDER_NONE_FIX)

    await runHealthyHost('--json')
    const document = JSON.parse(getOutput())
    const row = document.rows.find((entry: { name: string }) => entry.name === 'Embedder')

    expect(row.status).toBe('warn')
    expect(row.fix).toBe(EMBEDDER_NONE_FIX)
  })

  it("beside an idle daemon the Embedder WARN prints the static floor's fix, never the crash fix", async () => {
    knowledgeProbeStubs.readWriterLease.mockReturnValue({ kind: 'parsed', lease: {} } as never)
    knowledgeProbeStubs.readEmbedderWorkerRegistration.mockReturnValue({ kind: 'absent' })
    daemon.mockResolvedValueOnce({ kind: 'live', registration: { pid: 4242, startedAtMs: 1_000 } } as never)
    knowledgeProbeStubs.resolveEmbedderCapability.mockResolvedValue({
      kind: 'ready',
      rung: 'floor',
      profile: DEFAULT_EMBEDDING_PROFILE,
      embedder: {},
    } as never)

    await runHealthyHost()

    expect(rowFor('Embedder')).toContain('static floor — native ONNX runtime unavailable')
    expect(rowFor('Embedder')).toContain('when a run needs it')
    expect(rowFor('Embedder')).toContain('WARN')
    const fix = fixUnder('Embedder')
    expect(fix).not.toContain('exited with an error')
    expect(fix).not.toContain('daemon stop')
    expect(fix).toBe(EMBEDDER_FLOOR_FIX)
  })

  // The command measured against the width it resolved.

  it('stops a row at the Fix line instead of absorbing a failing check into it', async () => {
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({
      source: 'scan',
      reason: 'corrupt',
      detail: 'SQLITE_NOTADB: file is not a database',
      filePresent: true,
    })

    await runHealthyHost()

    const row = rowFor('Knowledge store')
    expect(row).toContain(MEASURED_FAIL_MESSAGE)
    expect(row).toContain('FAIL')
    // The fix line IS printed — so the two negatives below are about the JOIN, not about absence.
    expect(getOutput()).toContain(`Fix: ${MEASURED_FIX_INSTRUCTIONS}`)
    // The whole instruction string and the prefix literal. Deliberately not a token scan: the row
    // and its instructions legitimately share ordinary words ("index", "the", "at"), so a
    // token-by-token search would red on a correct helper, and "contains no substring" is
    // unsatisfiable as literally worded.
    expect(row).not.toContain(MEASURED_FIX_INSTRUCTIONS)
    expect(row).not.toContain('Fix: ')
  })

  it('emits no line wider than 80 columns at a resolved width of 80', async () => {
    forceTerminalWidth(80)
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({
      source: 'scan',
      reason: 'corrupt',
      detail: 'SQLITE_NOTADB: file is not a database',
      filePresent: true,
    })

    await runHealthyHost()

    const lines = consoleLogs.map(stripAnsi)
    // Strip before measuring even though picocolors disables itself off a TTY: the census must
    // measure what a COLOURED terminal receives, not what this harness happened to capture.
    const overlong = lines.filter(line => line.length > 80)
    // One exception: a word wider than the budget, such as a path, takes its own line uncut.
    const offenders = overlong
      .filter(line => line.trim().includes(' '))
      .map(line => `${line.length} columns: ${JSON.stringify(line)}`)
    expect(offenders).toEqual([])
    // And each exception really IS one unbroken token, never a word the wrapper cut in half.
    for (const line of overlong) expect(line.trim()).not.toContain(' ')

    // Non-vacuous: at least one row actually took the two-line shape, so a future change that made
    // every message short could not turn this census green by emptiness.
    const continuations = lines.filter(
      line => CONTINUATION_PATTERN.test(line) && !FIX_LINE_PATTERN.test(line),
    )
    expect(continuations.length).toBeGreaterThan(0)

    // The status word never left the name line.
    const head = lines.find(line => line.startsWith('    Knowledge store  '))
    expect(head).toContain('FAIL')
    expect(rowFor('Knowledge store')).toContain(MEASURED_FAIL_MESSAGE)
    expect(rowFor('Knowledge store')).toContain('FAIL')
  })

  it('emits no line ending in whitespace at a resolved width of 80', async () => {
    forceTerminalWidth(80)
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({
      source: 'scan',
      reason: 'corrupt',
      detail: 'SQLITE_NOTADB: file is not a database',
      filePresent: true,
    })

    await runHealthyHost()

    const lines = consoleLogs.map(stripAnsi)
    const trailing = lines
      .filter(line => line !== line.trimEnd())
      .map(line => JSON.stringify(line))
    expect(trailing).toEqual([])

    // Non-vacuous: the run really did emit rows and a wrapped Fix line, so this cannot pass by
    // emptiness the way a census over no output would.
    expect(lines.filter(line => line.startsWith('    '))).not.toHaveLength(0)
    expect(lines.filter(line => FIX_LINE_PATTERN.test(line))).not.toHaveLength(0)
  })

  it('leaves every row on one line at a wide width, byte-identical to the pre-change output', async () => {
    // 300 columns is wider than any row, so nothing wraps; the 80-column wrapping guards stay fixed.
    forceTerminalWidth(300)

    await runHealthyHost()

    const lines = consoleLogs.map(stripAnsi)
    expect(lines.filter(line => /^ {5}/.test(line))).toEqual([])
    expect(lines).toContain(
      preChangeRow('Knowledge store', 'index open at agent-qa-knowledge (memidex)', 'PASS'),
    )
    expect(lines).toContain(
      preChangeRow('Embedder', `native (${DEFAULT_EMBEDDING_PROFILE.model_id})`, 'PASS'),
    )
    expect(lines).toContain(preChangeRow('Retrieval rung', 'memidex', 'PASS'))
  })

  it('doctor prints its check table as one wrapped block under GitHub Actions', async () => {
    const pair = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
    mockReadFile.mockResolvedValue(`
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: '::set-output name=x::y'
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
` as never)
    mockExistsSync.mockImplementation((p) => String(p).endsWith('::set-output name=x::y'))
    const writes: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    try {
      await runDoctor()
    } finally {
      vi.unstubAllEnvs()
      stdoutSpy.mockRestore()
    }

    const blocks = writes.filter((write) => write.includes('::stop-commands::'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatch(pair)
    expect(blocks[0]).toContain('::set-output name=x::y found')
    expect(blocks[0]).toContain('Node.js')
    expect(blocks[0]).toContain('Test discovery')
    expect(blocks[0]).not.toContain('agent-qa doctor')
    const printed = getOutput()
    expect(printed).toContain('agent-qa doctor')
    expect(printed).toMatch(/All checks passed|Some checks failed/u)
    expect(printed).not.toContain('::set-output')
  })
})


// The renderer measured directly, with the width as a parameter rather than the host's.

/** A message of about the requested length built from short words, so no long-word exception fires. */
function wordyMessage(length: number): string {
  return 'lorem ipsum dolor sit amet '.repeat(20).slice(0, length).trimEnd()
}

describe('the Node version row', () => {
  const versionDescriptor = Object.getOwnPropertyDescriptor(process, 'version')!

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockReadFile.mockRejectedValue({ code: 'ENOENT' })
    mockLoadLLMAuthPlugins.mockResolvedValue([])
    mockLoadProviderPluginsForRawConfig.mockResolvedValue()
    mockReadFileSync.mockReturnValue('')
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({ source: 'index' })
    knowledgeProbeStubs.resolveEmbedderCapability.mockResolvedValue(NATIVE_READY)
    knowledgeProbeStubs.readWriterLease.mockReturnValue({ kind: 'absent' })
    knowledgeProbeStubs.readEmbedderWorkerRegistration.mockReturnValue({ kind: 'absent' })
    forceTerminalWidth(WIDE_TEST_WIDTH)
  })

  afterEach(() => {
    Object.defineProperty(process, 'version', versionDescriptor)
    restoreTerminalWidth()
    process.exitCode = 0
  })

  function nodeFixLine(): string | undefined {
    const lines = consoleLogs.map(stripAnsi)
    const start = lines.findIndex(line => line.startsWith('    Node.js  '))
    const next = lines[start + 1]
    return start >= 0 && next !== undefined && FIX_LINE_PATTERN.test(next) ? next : undefined
  }

  it('the Node row names the same install line as the bin', async () => {
    Object.defineProperty(process, 'version', { ...versionDescriptor, value: 'v22.0.0' })
    await runDoctor()
    const refused = rowFor('Node.js')
    expect(refused, getOutput()).toContain('v22.0.0')
    expect(refused, getOutput()).toContain('FAIL')
    expect(nodeFixLine(), getOutput()).toBe(
      '      Fix: Install Node.js 24 or newer from https://nodejs.org/, then run the command again.',
    )

    Object.defineProperty(process, 'version', versionDescriptor)
    await runDoctor()
    const supported = rowFor('Node.js')
    expect(supported, getOutput()).toContain(process.version)
    expect(supported, getOutput()).toContain('PASS')
    expect(nodeFixLine(), getOutput()).toBeUndefined()
  })
})

// Doctor's Config validation row gives the same fix as the config loader.
describe('the Config validation row', () => {
  const safeParse = vi.mocked(core.AgentQaConfigSchema.safeParse)
  const mockedParse = safeParse.getMockImplementation()
  const WORKSPACE = {
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['suites/**/*.suite.yaml'],
    hooksFile: 'hooks.yaml',
    envFile: '.env',
    secretsFile: '.env.secrets.local',
  }
  const REGISTRY = {
    llms: [{ name: 'default', provider: 'openai-compatible', model: 'gpt-4o', baseURL: 'https://api.openai.com/v1' }],
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockLoadLLMAuthPlugins.mockResolvedValue([])
    mockLoadProviderPluginsForRawConfig.mockResolvedValue()
    mockReadFileSync.mockReturnValue('')
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({ source: 'index' })
    knowledgeProbeStubs.resolveEmbedderCapability.mockResolvedValue(NATIVE_READY)
    knowledgeProbeStubs.readWriterLease.mockReturnValue({ kind: 'absent' })
    knowledgeProbeStubs.readEmbedderWorkerRegistration.mockReturnValue({ kind: 'absent' })
    forceTerminalWidth(WIDE_TEST_WIDTH)
    const real = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
    safeParse.mockImplementation(((config: unknown) => real.AgentQaConfigSchema.safeParse(config)) as never)
  })

  afterEach(() => {
    safeParse.mockImplementation(mockedParse as never)
    mockReadFile.mockRejectedValue({ code: 'ENOENT' })
    restoreTerminalWidth()
    process.exitCode = 0
  })

  async function configFix(config: Record<string, unknown>): Promise<string> {
    const { stringify } = await import('yaml')
    mockReadFile.mockResolvedValue(stringify(config) as never)
    await runDoctor()
    const lines = consoleLogs.map(stripAnsi)
    const start = lines.findIndex(line => line.startsWith('    Config validation  '))
    expect(start, getOutput()).toBeGreaterThanOrEqual(0)
    expect(rowFor('Config validation'), getOutput()).toContain('FAIL')
    const fixStart = lines.findIndex((line, index) => index > start && FIX_LINE_PATTERN.test(line))
    expect(fixStart, getOutput()).toBeGreaterThan(start)
    const parts = [(lines[fixStart] ?? '').replace(FIX_LINE_PATTERN, '')]
    for (let index = fixStart + 1; index < lines.length && /^ {11}\S/.test(lines[index] ?? ''); index += 1) {
      parts.push((lines[index] ?? '').trim())
    }
    return parts.join(' ')
  }

  it('doctor tells a v1 config the hard cut steps', async () => {
    const v1Fix = await configFix({
      workspace: WORKSPACE,
      services: { memory: { enabled: true, provider: 'local', dir: 'agent-qa-memory' } },
      registry: REGISTRY,
      use: { llm: 'default' },
    })
    expect(v1Fix).toContain('`npx agent-qa init --force`')
    expect(v1Fix).toContain('agent-qa-memory/')
    expect(v1Fix).not.toContain('re-run `agent-qa init`')

    const unknownKeyFix = await configFix({
      workspace: WORKSPACE,
      registry: REGISTRY,
      use: { llm: 'default' },
      planer: {},
    })
    expect(unknownKeyFix).toContain('Fix or remove the key named above')
    expect(unknownKeyFix).not.toContain('agent-qa-memory/')
    expect(unknownKeyFix).not.toContain('re-run `agent-qa init`')
  })

  it('doctor names a removed eval block and gives the key fix, not the hard cut steps', async () => {
    const fix = await configFix({
      workspace: WORKSPACE,
      registry: REGISTRY,
      use: { llm: 'default' },
      eval: { gate1: { maxPerJob: 2 } },
    })
    expect(rowFor('Config validation'), getOutput()).toContain(
      'eval.gate1: eval.gate1 was removed: memory is no longer screened by replay before promotion.',
    )
    expect(fix).toContain('Fix or remove the key named above')
    expect(fix).not.toContain('agent-qa-memory/')
    expect(fix).not.toContain('Delete .agent-qa/')
  })
})

describe('the LLM auth rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockLoadLLMAuthPlugins.mockResolvedValue([])
    mockLoadProviderPluginsForRawConfig.mockResolvedValue()
    mockReadFileSync.mockReturnValue('')
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({ source: 'index' })
    knowledgeProbeStubs.resolveEmbedderCapability.mockResolvedValue(NATIVE_READY)
    knowledgeProbeStubs.readWriterLease.mockReturnValue({ kind: 'absent' })
    knowledgeProbeStubs.readEmbedderWorkerRegistration.mockReturnValue({ kind: 'absent' })
    forceTerminalWidth(WIDE_TEST_WIDTH)
  })

  afterEach(() => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' })
    restoreTerminalWidth()
    process.exitCode = 0
  })

  async function credentialFix(name: string, provider: string, model: string): Promise<string> {
    mockReadFile.mockResolvedValue(
      `registry:\n  llms:\n    - name: ${name}\n      provider: ${provider}\n      model: ${model}\nuse:\n  llm: ${name}\n` as never,
    )
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: name,
      provider,
      required: true,
      message: 'No credential saved.',
    })
    await runDoctor()
    const lines = consoleLogs.map(stripAnsi)
    const start = lines.findIndex(line => line.startsWith('    LLM credential  '))
    expect(start, getOutput()).toBeGreaterThanOrEqual(0)
    expect(rowFor('LLM credential'), getOutput()).toContain('FAIL')
    const fixStart = lines.findIndex((line, index) => index > start && FIX_LINE_PATTERN.test(line))
    expect(fixStart, getOutput()).toBeGreaterThan(start)
    const parts = [(lines[fixStart] ?? '').replace(FIX_LINE_PATTERN, '')]
    for (let index = fixStart + 1; index < lines.length && /^ {11}\S/.test(lines[index] ?? ''); index += 1) {
      parts.push((lines[index] ?? '').trim())
    }
    return parts.join(' ')
  }

  it('a subscription that is not signed in is told to sign in with its configured name', async () => {
    const fix = await credentialFix('claude-code', 'anthropic-subscription', 'claude-sonnet-4-6')

    expect(fix).toBe('Sign in with `npx agent-qa auth login --config claude-code`.')
  })

  it('an API-key provider without a key is sent to the model page or auth set, never auth login', async () => {
    const fix = await credentialFix('gemini', 'gemini', 'gemini-3-flash-preview')

    expect(fix).toContain('npx agent-qa dashboard --open /config/models')
    expect(fix).toContain('`npx agent-qa auth set --config gemini --type api-key`')
    expect(fix).not.toContain('auth login')
  })

  it('the connection fix names the configured entry', async () => {
    await credentialFix('gemini', 'gemini', 'gemini-3-flash-preview')

    expect(rowFor('LLM connection'), getOutput()).toContain('FAIL')
    expect(fixUnder('LLM connection')).toContain('`npx agent-qa auth test --config gemini`')
  })

  it('no fix carries a literal <name> once a model is configured', async () => {
    mockReadFile.mockResolvedValue(
      'registry:\n  llms:\n    - name: gemini\n      provider: gemini\n      model: gemini-3-flash-preview\n' as never,
    )
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'gemini',
      provider: 'gemini',
      required: true,
      message: 'No credential saved.',
    })

    await runDoctor(undefined, '--json')
    const rows = JSON.parse(getOutput()).rows as { name: string; fix?: string }[]

    const modelFixes = rows.filter(row => row.name.startsWith('LLM ') && row.fix !== undefined)
    expect(modelFixes.map(row => row.name)).toEqual(['LLM credential', 'LLM connection'])
    for (const row of rows) expect(row.fix ?? '', row.name).not.toContain('<name>')
    const subscription = checkSubscriptionAuth({ registry: { llms: [{ name: 'gemini', provider: 'gemini' }] } })
    expect(subscription.fixInstructions).not.toContain('<name>')
  })

  it('the Subscription Auth fix adds the plugin with plugins add, then signs in', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'claude-code',
      provider: 'anthropic-subscription',
      required: true,
      message: 'Provider "anthropic-subscription" needs the subscription-auth plugin.',
    })
    const row = checkSubscriptionAuth({
      registry: {
        llms: [{ name: 'claude-code', provider: 'anthropic-subscription', model: 'claude-sonnet-4-6' }],
      },
      use: { llm: 'claude-code' },
    })

    expect((await row.check()).status).toBe('warn')
    expect(row.fixInstructions).toBe(
      'Run `npx agent-qa plugins add @vostride/agent-qa-subscription-auth`, then run '
        + '`npx agent-qa auth login --config claude-code`',
    )
    expect(row.fixInstructions).not.toContain('npm install')
  })

  it('the Subscription Auth fix names a config that is not the default one', () => {
    const row = checkSubscriptionAuth(
      {
        registry: {
          llms: [{ name: 'claude-code', provider: 'anthropic-subscription', model: 'claude-sonnet-4-6' }],
        },
        use: { llm: 'claude-code' },
      },
      resolve(process.cwd(), 'staging.yaml'),
    )

    expect(row.fixInstructions).toBe(
      'Run `npx agent-qa --config staging.yaml plugins add @vostride/agent-qa-subscription-auth`, '
        + 'then run `npx agent-qa auth login --config claude-code`',
    )
  })

  it('a compatible config with no key on the public provider API fails the credential row with auth set', async () => {
    type Core = typeof import('@vostride/agent-qa-core')
    type FsPromises = typeof import('node:fs/promises')
    const real = await vi.importActual<Core>('@vostride/agent-qa-core')
    const { mkdtemp, rm } = await vi.importActual<FsPromises>('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'agent-qa-doctor-'))
    const authPath = resolve(tempDir, 'auth.json')
    const configYaml = [
      'registry:',
      '  llms:',
      '    - name: default',
      '      provider: anthropic-compatible',
      '      model: claude-sonnet-4-6',
      '      baseURL: https://api.anthropic.com/v1',
      'use:',
      '  llm: default',
      '',
    ].join('\n')
    const defaultResolve = mockResolveLLMAuth.getMockImplementation()
    try {
      mockReadFile.mockImplementation(((path: unknown) => path === 'agent-qa.config.yaml'
        ? Promise.resolve(configYaml)
        : Promise.reject({ code: 'ENOENT' })) as never)
      type LLMConfig = Parameters<Core['resolveLLMAuth']>[1]
      mockResolveLLMAuth.mockImplementation((name: string, llm: LLMConfig) =>
        real.resolveLLMAuth(name, llm, authPath))

      await runDoctor()

      const credentialRow = rowFor('LLM credential')
      expect(credentialRow, getOutput()).toContain('FAIL')
      const expected = await real.resolveLLMAuth('default', {
        provider: 'anthropic-compatible',
        model: 'claude-sonnet-4-6',
        baseURL: 'https://api.anthropic.com/v1',
      }, authPath)
      expect(expected.kind, getOutput()).toBe('missing')
      if (expected.kind !== 'missing') throw new Error('Expected missing result')
      expect(credentialRow, getOutput()).toContain(expected.message)

      const lines = consoleLogs.map(stripAnsi)
      const start = lines.findIndex(line => line.startsWith('    LLM credential  '))
      const fixStart = lines.findIndex(
        (line, index) => index > start && FIX_LINE_PATTERN.test(line),
      )
      expect(fixStart, getOutput()).toBeGreaterThan(start)
      const fix = [(lines[fixStart] ?? '').replace(FIX_LINE_PATTERN, '')]
      for (let index = fixStart + 1; /^ {11}\S/.test(lines[index] ?? ''); index += 1) {
        fix.push((lines[index] ?? '').trim())
      }
      expect(fix.join(' ')).toContain('agent-qa auth set --config default --type api-key')

      const connectionRow = rowFor('LLM connection')
      expect(connectionRow, getOutput()).toContain('FAIL')
      expect(connectionRow, getOutput()).toContain(expected.message)
      expect(mockGenerateText).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(3)
    } finally {
      mockResolveLLMAuth.mockImplementation(defaultResolve)
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('the Model row', () => {
  type DocumentRow = { name: string; status: string; message: string; fix?: string }

  const twoModels = {
    registry: {
      llms: [
        { name: 'first', provider: 'openai-compatible', model: 'deepseek-chat', baseURL: 'https://one.example/v1' },
        { name: 'second', provider: 'gemini', model: 'gemini-3-flash-preview' },
      ],
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockLoadLLMAuthPlugins.mockResolvedValue([])
    mockLoadProviderPluginsForRawConfig.mockResolvedValue()
    mockReadFileSync.mockReturnValue('')
    knowledgeProbeStubs.classifyIndexFace.mockReturnValue({ source: 'index' })
    knowledgeProbeStubs.resolveEmbedderCapability.mockResolvedValue(NATIVE_READY)
    knowledgeProbeStubs.readWriterLease.mockReturnValue({ kind: 'absent' })
    knowledgeProbeStubs.readEmbedderWorkerRegistration.mockReturnValue({ kind: 'absent' })
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
  })

  afterEach(() => {
    mockReadFile.mockRejectedValue({ code: 'ENOENT' })
    process.exitCode = 0
  })

  async function doctorRows(config: Record<string, unknown>): Promise<DocumentRow[]> {
    const { stringify } = await import('yaml')
    mockReadFile.mockResolvedValue(stringify(config) as never)
    await runDoctor(undefined, '--json')
    return JSON.parse(getOutput()).rows as DocumentRow[]
  }

  function row(rows: readonly DocumentRow[], name: string): DocumentRow | undefined {
    return rows.find(entry => entry.name === name)
  }

  it('fails a config with no model, names the dashboard and init --llm, and exits 3', async () => {
    const rows = await doctorRows({ use: {} })

    const model = row(rows, 'Model')
    expect(model?.status).toBe('fail')
    expect(model?.message).toBe('no model configured')
    expect(model?.fix).toContain('npx agent-qa dashboard --open /config/models')
    expect(model?.fix).toContain('npx agent-qa init --llm <choice>')
    expect(process.exitCode).toBe(3)
  })

  it('skips the credential, Subscription Auth and connection rows when no model is configured', async () => {
    const rows = await doctorRows({ registry: { llms: [] } })

    for (const name of ['LLM credential', 'Subscription Auth', 'LLM connection']) {
      expect(row(rows, name), name).toMatchObject({ status: 'skip', message: 'no model configured' })
    }
    expect(mockResolveLLMAuth).not.toHaveBeenCalled()
    expect(JSON.stringify(rows)).not.toContain('anthropic-subscription')
  })

  it('reads a malformed model list and target as validate would leave them, without crashing', async () => {
    const rows = await doctorRows({ registry: { llms: {}, targets: { web: null } }, use: 'x' })

    expect(row(rows, 'Model')).toMatchObject({ status: 'fail', message: 'no model configured' })
    expect(row(rows, 'Playwright')).toMatchObject({ status: 'pass' })
  })

  it('skips a model list item that is not a named mapping', async () => {
    const rows = await doctorRows({
      registry: { llms: [null, 'gemini', { name: 'second', provider: 'gemini', model: 'm' }] },
    })

    expect(row(rows, 'Model')).toMatchObject({ status: 'pass', message: 'second: gemini m' })
  })

  it('checks the entry use.llm names, the one run resolves', async () => {
    const config = { ...twoModels, use: { llm: 'second' } }
    const rows = await doctorRows(config)

    expect(resolveLLMModels(config).configName).toBe('second')
    expect(row(rows, 'Model')).toMatchObject({
      status: 'pass',
      message: 'second: gemini gemini-3-flash-preview',
    })
    expect(mockResolveLLMAuth).toHaveBeenCalledWith(
      'second', expect.objectContaining({ provider: 'gemini' }), NO_PROJECT_AUTH_PATH, 'agent-qa.config.yaml',
    )
    expect(mockResolveLLMAuth).not.toHaveBeenCalledWith('first', expect.anything(), expect.anything(), expect.anything())
  })

  it('checks the first entry when use.llm is not set, the one run resolves', async () => {
    const rows = await doctorRows(twoModels)

    expect(resolveLLMModels(twoModels).configName).toBe('first')
    expect(row(rows, 'Model')).toMatchObject({
      status: 'pass',
      message: 'first: openai-compatible deepseek-chat',
    })
    expect(mockResolveLLMAuth).toHaveBeenCalledWith(
      'first', expect.objectContaining({ model: 'deepseek-chat' }), NO_PROJECT_AUTH_PATH, 'agent-qa.config.yaml',
    )
    expect(mockResolveLLMAuth).not.toHaveBeenCalledWith('second', expect.anything(), expect.anything(), expect.anything())
  })

  it('keeps the credential FAIL for a configured subscription that is not signed in', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'claude-code',
      provider: 'anthropic-subscription',
      required: true,
      message: 'Sign in to use claude-code.',
    })
    const rows = await doctorRows({
      registry: { llms: [{ name: 'claude-code', provider: 'anthropic-subscription', model: 'claude-sonnet-5-5' }] },
      use: { llm: 'claude-code' },
    })

    expect(row(rows, 'Model')?.status).toBe('pass')
    expect(row(rows, 'LLM credential')).toMatchObject({ status: 'fail', message: 'Sign in to use claude-code.' })
    expect(process.exitCode).toBe(3)
  })
})

describe('doctor row renderer', () => {
  const originalColumnsEnv = process.env.COLUMNS

  afterEach(() => {
    restoreTerminalWidth()
    if (originalColumnsEnv === undefined) delete process.env.COLUMNS
    else process.env.COLUMNS = originalColumnsEnv
  })

  it('resolves the width from stdout first, then COLUMNS, then the documented default', () => {
    setStdoutColumns(133)
    process.env.COLUMNS = '44'
    expect(resolveTerminalWidth()).toBe(133)

    setStdoutColumns(undefined)
    expect(resolveTerminalWidth()).toBe(44)

    delete process.env.COLUMNS
    expect(resolveTerminalWidth()).toBe(DEFAULT_TERMINAL_WIDTH)
    expect(DEFAULT_TERMINAL_WIDTH).toBe(80)
  })

  // `COLUMNS=4` would drive the content budget negative, so the resolved width is floored.
  it('floors the resolved width, so no environment can claim a width with no content column', () => {
    setStdoutColumns(4)
    expect(resolveTerminalWidth()).toBe(MIN_USABLE_WIDTH)

    setStdoutColumns(undefined)
    process.env.COLUMNS = '4'
    expect(resolveTerminalWidth()).toBe(MIN_USABLE_WIDTH)

    // The deepest indent the command writes is the eleven-column `Fix: ` hanging indent, so the
    // floor must leave content columns beneath even that.
    expect(MIN_USABLE_WIDTH).toBeGreaterThan(11)
  })

  it('ignores a non-positive or unparseable width from either source', () => {
    setStdoutColumns(0)
    process.env.COLUMNS = 'wide'
    expect(resolveTerminalWidth()).toBe(DEFAULT_TERMINAL_WIDTH)

    setStdoutColumns(Number.NaN)
    process.env.COLUMNS = '-20'
    expect(resolveTerminalWidth()).toBe(DEFAULT_TERMINAL_WIDTH)
  })

  it('composes a fitting row byte-for-byte the way the pre-change emit loop did', () => {
    const name = 'Knowledge store'
    const message = 'index open at agent-qa-knowledge (memidex)'

    const row = formatCheckRow(name, message, 'pass', 200)

    expect(row.plainLine).toBe(preChangeRow(name, message, 'PASS'))
    expect(row.continuations).toEqual([])
    expect(row.message).toBe(message)
  })

  it('never adds dots: a row that already fits keeps the exact gutter it has today', () => {
    const name = 'Node.js'
    const message = 'v24.10.0'

    for (const width of [80, 120, 400]) {
      expect(formatCheckRow(name, message, 'pass', width).plainLine)
        .toBe(preChangeRow(name, message, 'PASS'))
    }
  })

  it('keeps FAIL on the name line and wraps the measured 113-column row under 80', () => {
    // The width measured on the built cli, reproduced from the same two strings.
    expect(preChangeRow('Knowledge store', MEASURED_FAIL_MESSAGE, 'FAIL')).toHaveLength(113)

    const row = formatCheckRow('Knowledge store', MEASURED_FAIL_MESSAGE, 'fail', 80)

    expect(row.plainLine).toContain('Knowledge store')
    expect(row.plainLine).toContain('FAIL')
    expect(row.message).toBe('')
    expect(row.continuations.length).toBeGreaterThan(1)
    for (const line of [row.plainLine, ...row.continuations]) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
    // Nothing was cut: the wrapped lines rejoin into the message exactly.
    expect(row.continuations.map(line => line.trim()).join(' ')).toBe(MEASURED_FAIL_MESSAGE)
    // The gutter degrades to padDots' floor rather than going negative.
    expect(row.dots.length).toBeGreaterThanOrEqual(2)
  })

  it('bounds every returned line at the width across the name x message x status corpus', () => {
    const statuses: CheckStatus[] = ['pass', 'warn', 'fail', 'skip']
    const offenders: string[] = []

    for (const width of [60, 80, 120]) {
      for (let nameLength = 1; nameLength <= 40; nameLength += 1) {
        const name = 'n'.repeat(nameLength)
        for (let messageLength = 1; messageLength <= 200; messageLength += 1) {
          const message = wordyMessage(messageLength)
          for (const status of statuses) {
            const row = formatCheckRow(name, message, status, width)
            for (const line of [row.plainLine, ...row.continuations]) {
              if (line.length > width) {
                offenders.push(
                  `width=${width} name=${nameLength} message=${messageLength} status=${status}`
                  + ` produced ${line.length} columns: ${JSON.stringify(line)}`,
                )
              }
            }
          }
        }
      }
    }

    expect(offenders.slice(0, 5)).toEqual([])
  })

  // Sweeps the widths and names where the head-line exception is reachable; samples messages.
  it('classifies every over-wide line into one of the two documented exceptions, and observes both', () => {
    const statuses: CheckStatus[] = ['pass', 'warn', 'fail', 'skip']
    /** Widths at or below the floor's reach, so `affordable < MIN_DOTS` is attainable. */
    const narrowWidths = [20, 24, 32, 40, 48]
    /** Sampled, not swept — including one message carrying a token wider than any budget here. */
    const sampledMessages: [string, string][] = [
      ['empty', ''],
      ['one short word', 'corrupt'],
      ['wordy 23', wordyMessage(23)],
      ['wordy 60', wordyMessage(60)],
      ['wordy 137', wordyMessage(137)],
      ['long token', `index at ${MEASURED_INDEX_PATH} could not be opened: corrupt`],
    ]

    const offenders: string[] = []
    let uncutTokenLines = 0
    let headFloorLines = 0
    let combinations = 0

    for (const width of narrowWidths) {
      for (let nameLength = 1; nameLength <= 70; nameLength += 1) {
        const name = 'n'.repeat(nameLength)
        for (const [label, message] of sampledMessages) {
          for (const status of statuses) {
            combinations += 1
            const row = formatCheckRow(name, message, status, width)
            for (const line of [row.plainLine, ...row.continuations]) {
              if (line.length <= width) continue
              // Exception one: a word wider than the budget takes its own line uncut.
              if (!line.trim().includes(' ')) {
                uncutTokenLines += 1
                continue
              }
              // Exception two: the `MIN_DOTS` floor makes the head line `name.length + 14` wide.
              if (
                line === row.plainLine
                && line.length === nameLength + 14
                && nameLength + 14 > width
              ) {
                headFloorLines += 1
                continue
              }
              offenders.push(
                `width=${width} name=${nameLength} message=${label} status=${status}`
                + ` produced ${line.length} columns in NEITHER documented exception:`
                + ` ${JSON.stringify(line)}`,
              )
            }
          }
        }
      }
    }

    expect(offenders.slice(0, 5)).toEqual([])
    expect(combinations).toBe(narrowWidths.length * 70 * sampledMessages.length * statuses.length)
    expect(
      uncutTokenLines,
      'exception one (a word wider than the budget, uncut and alone) never fired in this sweep,'
      + ' so the classification proved nothing about it',
    ).toBeGreaterThan(0)
    expect(
      headFloorLines,
      'exception two (the head line at name.length + 14, produced by the MIN_DOTS floor) never'
      + ' fired in this sweep, so the corpus is still not reaching the reported case',
    ).toBeGreaterThan(0)
  })

  it('gives a word longer than the wrap budget its own uncut line, the only line that may exceed the width', () => {
    const sha = 'a'.repeat(64)

    const row = formatCheckRow(
      'Knowledge store',
      `index at ${sha} could not be opened: corrupt`,
      'fail',
      40,
    )

    const overlong = [row.plainLine, ...row.continuations].filter(line => line.length > 40)
    expect(overlong).toHaveLength(1)
    // Uncut and alone on its line: a sha a person cannot copy is a sha this row failed to report.
    expect(overlong[0]?.trim()).toBe(sha)
  })

  // This floor bounds a direct call, as the resolver bounds the environment.
  it('puts one word per line rather than taking a negative budget when a caller asks below the indent', () => {
    const row = formatCheckRow('n', 'alpha beta gamma', 'fail', 3)

    expect(row.continuations.map(line => line.trim())).toEqual(['alpha', 'beta', 'gamma'])
    for (const line of row.continuations) expect(line.startsWith('      ')).toBe(true)
  })

  it('wraps the measured 160-column Fix line with a hanging indent, keeping its six-space prefix', () => {
    expect(`      Fix: ${MEASURED_FIX_INSTRUCTIONS}`).toHaveLength(160)

    const lines = formatFixLines(MEASURED_FIX_INSTRUCTIONS, 80)

    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]?.startsWith('      Fix: ')).toBe(true)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80)
    for (const line of lines.slice(1)) expect(line.startsWith('           ')).toBe(true)
    expect(lines.map(line => line.trim()).join(' ')).toBe(`Fix: ${MEASURED_FIX_INSTRUCTIONS}`)
  })

  it('leaves a short Fix line exactly as the pre-change emit loop wrote it', () => {
    expect(formatFixLines('Install Node.js 24+ from https://nodejs.org/', 80)).toEqual([
      '      Fix: Install Node.js 24+ from https://nodejs.org/',
    ])
  })

  it('pins the SHIPPED decoration through the SHIPPED composer to plainLine', () => {
    // What this buys over a self-consistency check: asserting `plainLine` equals a composition of
    // its OWN segments proves only that the formatter agrees with itself, and would stay green
    // while the emit path composed something else entirely. Running the decoration the emit loop
    // actually passes through the composer the emit loop actually calls, then stripping it, is
    // what pins the emitted line to the pinned one.
    const cases: [string, number][] = [
      ['index open at agent-qa-knowledge (memidex)', 200],
      [MEASURED_FAIL_MESSAGE, 80],
    ]

    for (const [message, width] of cases) {
      const row = formatCheckRow('Knowledge store', message, 'fail', width)

      expect(stripAnsi(composeRow(row, { dots: pc.dim, status: formatStatus }))).toBe(row.plainLine)

      // Non-vacuity: picocolors disables itself off a TTY, so the assertion above can degrade to an
      // identity check on this host. Forcing escapes proves stripAnsi is doing real work.
      const forced = composeRow(row, {
        dots: segment => `${ESC}[2m${segment}${ESC}[22m`,
        status: segment => `${ESC}[31m${segment}${ESC}[39m`,
      })
      expect(forced).not.toBe(row.plainLine)
      expect(stripAnsi(forced)).toBe(row.plainLine)
    }
  })

  it('composes with identity decorators to exactly the plain line', () => {
    const row = formatCheckRow('Embedder', 'native (all-MiniLM-L6-v2)', 'pass', 120)
    expect(composeRow(row, IDENTITY_DECORATION)).toBe(row.plainLine)
  })
})

// A newline measures one column but breaks the line, and `wrapWords` collapses spaces.

/**
 * The message text a row carries, whichever shape it took, with the LINE JOINS collapsed and
 * nothing else.
 *
 * Deliberately not a whitespace normaliser: normalising here would hide exactly the defect this
 * block measures. Continuation lines are trimmed and joined with one space because that join is
 * an artefact of wrapping; every other space inside the message is left exactly as the renderer
 * emitted it, so a double space surviving on one path and not the other still shows up.
 */
function messageTextOf(row: CheckRow): string {
  const parts = row.message === '' ? row.continuations : [row.message]
  return parts.map(part => part.trim()).join(' ')
}

/** A producer message carrying a break the command never wrote — `doctor.ts:505`, `:591`, `:401`. */
const NEWLINE_MESSAGE = 'Authentication failed\nresponse: 401'
/** A composed message whose spacing is deliberate, carrying a double space AND a tab. */
const SPACED_MESSAGE =
  'index at agent-qa-knowledge/memory/index/knowledge.db  could not be opened:\tcorrupt'

describe('doctor row renderer: the flattening law', () => {
  afterEach(() => {
    restoreTerminalWidth()
  })

  it('never emits a line containing the break a producer smuggled into the message', () => {
    for (const width of [40, 80, 200, 400]) {
      const row = formatCheckRow('LLM connection', NEWLINE_MESSAGE, 'fail', width)

      // A property of EVERY emitted line, not of one arrangement of one message: the assertion
      // scans what the command would print rather than comparing to a hand-built expectation.
      for (const line of [row.plainLine, ...row.continuations]) {
        expect(line).not.toContain('\n')
      }
    }
  })

  it('keeps the status word on the name line the terminal actually draws', () => {
    const row = formatCheckRow('LLM connection', NEWLINE_MESSAGE, 'fail', 80)

    // `plainLine` is ONE terminal line by construction, which is what makes the length check and
    // the display width the same number. Before flattening this split into two, and `FAIL` sat on
    // the second — read by a scanner as the verdict of the row below.
    expect(row.plainLine.split('\n')).toHaveLength(1)
    expect(row.plainLine).toContain('LLM connection')
    expect(row.plainLine).toContain('FAIL')
  })

  it('decides the shape on the flattened length, not on the raw one', () => {
    const wide = formatCheckRow('LLM connection', NEWLINE_MESSAGE, 'fail', 200)
    expect(wide.continuations).toEqual([])
    expect(wide.message).toBe('Authentication failed response: 401')

    const narrow = formatCheckRow('LLM connection', NEWLINE_MESSAGE, 'fail', 50)
    expect(narrow.message).toBe('')
    expect(narrow.continuations.length).toBeGreaterThan(0)
    expect(narrow.continuations.map(line => line.trim()).join(' '))
      .toBe('Authentication failed response: 401')
  })

  it('renders the same message text at 80 columns and at 400', () => {
    const narrow = formatCheckRow('Knowledge store', SPACED_MESSAGE, 'fail', 80)
    const wide = formatCheckRow('Knowledge store', SPACED_MESSAGE, 'fail', 400)

    // Non-vacuity: the two widths really did take the two different shapes, so this cannot pass by
    // both paths happening to be the same path.
    expect(narrow.continuations.length).toBeGreaterThan(0)
    expect(wide.continuations).toEqual([])

    expect(messageTextOf(narrow)).toBe(messageTextOf(wide))
    expect(messageTextOf(wide))
      .toBe('index at agent-qa-knowledge/memory/index/knowledge.db could not be opened: corrupt')
  })

  it('gives a whitespace-only message the no-message shape', () => {
    for (const blank of ['   ', '\t', '\n', ' \t \n ']) {
      const row = formatCheckRow('Embedder', blank, 'skip', 80)
      const empty = formatCheckRow('Embedder', '', 'skip', 80)

      expect(row.plainLine).toBe(empty.plainLine)
      expect(row.message).toBe('')
      expect(row.continuations).toEqual([])
    }
  })

  it('flattens the fix instruction too, so no Fix line carries a break', () => {
    const inputs = [
      'Rebuild the index with `agent-qa knowledge rebuild-index`,\nor remove the corrupt file.',
      'Run\t`agent-qa auth test`',
      '\n',
    ]

    for (const instructions of inputs) {
      for (const line of formatFixLines(instructions, 80)) {
        expect(line).not.toContain('\n')
        expect(line).not.toContain('\t')
      }
    }
  })
})

// `formatStatus` takes the typed status word, so a lowercase `pass` fails to type-check.

describe('doctor status token', () => {
  it('paints every status word, and the table has no silent fallback left', async () => {
    // picocolors decides `isColorSupported` ONCE, at its own module load, and `STATUS_COLOURS`
    // captures the bound formatters. So the only way to see real paint is a fresh doctor module
    // over a colour-ENABLED picocolors. Without that this cell degrades to an identity check and
    // could not tell a painted word from a dropped table entry.
    vi.doMock('picocolors', async () => {
      const actual = await vi.importActual<{ default: typeof pc }>('picocolors')
      return { default: (actual.default as unknown as { createColors: (on: boolean) => typeof pc })
        .createColors(true) }
    })
    vi.resetModules()
    try {
      const { formatStatus: paint } = await import('../commands/doctor-row.js')

      for (const word of ['PASS', 'WARN', 'FAIL', 'SKIP'] as const) {
        const painted = paint(word)
        expect(painted).not.toBe(word)
        expect(stripAnsi(painted)).toBe(word)
      }
    } finally {
      vi.doUnmock('picocolors')
      vi.resetModules()
    }
  })

  it('rejects a lowercase CheckStatus where a status WORD belongs', () => {
    // @ts-expect-error a `CheckStatus` is not a `StatusWord`; an unused directive fails tsc.
    expect(() => formatStatus('pass')).toThrow(TypeError)
  })
})

// An empty instruction renders no fix line rather than one of trailing whitespace.

describe('doctor fix lines: nothing to instruct', () => {
  it('returns no line at all for an instruction with no content', () => {
    for (const instructions of ['', '   ', '\n', '\t \n']) {
      expect(formatFixLines(instructions, 80)).toEqual([])
    }
  })

  it('still writes a short instruction exactly as the pre-change emit loop did', () => {
    expect(formatFixLines('Install Node.js 24+ from https://nodejs.org/', 80)).toEqual([
      '      Fix: Install Node.js 24+ from https://nodejs.org/',
    ])
  })
})

// Drives `rowFor` over a synthetic log, seeding a real six-space continuation so joining all fails.

describe('doctor row reader: one definition of a continuation', () => {
  const HEAD = '    Knowledge store  ..........  FAIL'
  const REAL_CONTINUATION = `      ${MEASURED_FAIL_MESSAGE}`
  const NEXT_ROW = '    Embedder  ..........  PASS'

  afterEach(() => {
    consoleLogs.length = 0
  })

  function seed(...lines: string[]): void {
    consoleLogs.length = 0
    consoleLogs.push(...lines)
  }

  it('ends the row at a FIVE-space line instead of joining it', () => {
    seed(HEAD, REAL_CONTINUATION, '     five-space impostor', NEXT_ROW)

    const row = rowFor('Knowledge store')

    expect(
      row,
      'the five-space line was joined: the reader is still using the /^ {5}/ rule instead of'
      + ' CONTINUATION_PATTERN, which the census and the emit loop both spell as six spaces',
    ).toBe(`${HEAD} ${MEASURED_FAIL_MESSAGE}`)
    expect(row).not.toContain('impostor')
  })

  it('ends the row at a six-space line with nothing after the indent', () => {
    seed(
      HEAD,
      REAL_CONTINUATION,
      '      ',
      '      text beneath the blank padded line',
      NEXT_ROW,
    )

    const row = rowFor('Knowledge store')

    expect(
      row,
      'a blank padded line was joined: the reader is using an indent-only rule, while'
      + ' CONTINUATION_PATTERN requires a NON-SPACE after the six spaces',
    ).toBe(`${HEAD} ${MEASURED_FAIL_MESSAGE}`)
    expect(row.endsWith(' ')).toBe(false)
    expect(row).not.toContain('text beneath the blank padded line')
  })
})
