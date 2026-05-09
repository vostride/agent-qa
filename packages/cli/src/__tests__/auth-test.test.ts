import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Command } from 'commander'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(() => Promise.reject({ code: 'ENOENT' })),
}))

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}))

vi.mock('@inquirer/input', () => ({
  default: vi.fn(() => Promise.resolve('auth-code')),
}))

vi.mock('@inquirer/password', () => ({
  default: vi.fn(() => Promise.resolve('prompt-secret')),
}))

vi.mock('@inquirer/select', () => ({
  default: vi.fn(() => Promise.resolve('anthropic-subscription')),
}))

vi.mock('@vostride/agent-qa-core', () => ({
  createModel: vi.fn(() => ({})),
  getProviderOptions: vi.fn(() => undefined),
  getCredential: vi.fn(() => null),
  getLLMAuthProviderPlugin: vi.fn(() => undefined),
  readAuth: vi.fn(() => ({})),
  removeAuth: vi.fn(() => Promise.resolve()),
  writeAuth: vi.fn(() => Promise.resolve()),
}))

vi.mock('ai', () => ({
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
}))

vi.mock('../llm-utils.js', () => ({
  loadAuthPluginsForRawConfig: vi.fn(() => Promise.resolve()),
  resolveCredentials: vi.fn(() => Promise.resolve({ apiKey: 'test-key' })),
  resolveModelAuth: vi.fn(() => Promise.resolve({
    kind: 'api-key',
    credentialKey: 'default',
    provider: 'openai-compatible',
    apiKey: 'test-key',
  })),
  resolveLLMModels: vi.fn(() => ({
    planner: { provider: 'openai-compatible', model: 'model-name', baseURL: 'https://remote.example/v1' },
    verifier: { provider: 'openai-compatible', model: 'model-name', baseURL: 'https://remote.example/v1' },
    configName: 'default',
  })),
  resolveNamedConfig: vi.fn(() => Promise.resolve({
    config: {
      name: 'default',
      provider: 'openai-compatible',
      model: 'model-name',
      baseURL: 'https://remote.example/v1',
    },
    allConfigs: [{
      name: 'default',
      provider: 'openai-compatible',
      model: 'model-name',
      baseURL: 'https://remote.example/v1',
    }],
    defaultName: 'default',
  })),
}))

vi.mock('../config.js', () => ({
  loadConfigFile: vi.fn(() =>
    Promise.resolve({
      registry: {
        llms: [{
          name: 'default',
          provider: 'openai-compatible',
          model: 'model-name',
          baseURL: 'https://remote.example/v1',
        }],
      },
      use: { llm: 'default' },
    }),
  ),
}))

const consoleLogs: string[] = []
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  consoleLogs.push(args.map(String).join(' '))
})
vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
  consoleLogs.push(args.map(String).join(' '))
})

import { createAuthCommand } from '../commands/auth.js'
import { generateText } from 'ai'
import {
  createModel,
  getLLMAuthProviderPlugin,
  removeAuth,
  writeAuth,
} from '@vostride/agent-qa-core'
import { exec } from 'node:child_process'
import input from '@inquirer/input'
import password from '@inquirer/password'
import {
  resolveCredentials,
  resolveLLMModels,
  resolveModelAuth,
  resolveNamedConfig,
} from '../llm-utils.js'
import { loadConfigFile } from '../config.js'

const mockGenerateText = vi.mocked(generateText)
const mockCreateModel = vi.mocked(createModel)
const mockGetLLMAuthProviderPlugin = vi.mocked(getLLMAuthProviderPlugin)
const mockResolveCredentials = vi.mocked(resolveCredentials)
const mockResolveModelAuth = vi.mocked(resolveModelAuth)
const mockResolveLLMModels = vi.mocked(resolveLLMModels)
const mockResolveNamedConfig = vi.mocked(resolveNamedConfig)
const mockRemoveAuth = vi.mocked(removeAuth)
const mockWriteAuth = vi.mocked(writeAuth)
const mockExec = vi.mocked(exec)
const mockInput = vi.mocked(input)
const mockPassword = vi.mocked(password)
const mockLoadConfigFile = vi.mocked(loadConfigFile)

async function runAuthCommand(args: string[] = [], parentConfig?: string): Promise<void> {
  consoleLogs.length = 0
  const parent = new Command()
  if (parentConfig) parent.setOptionValue('config', parentConfig)
  parent.exitOverride()
  const auth = createAuthCommand()
  auth.exitOverride()
  parent.addCommand(auth)
  await parent.parseAsync(['node', 'test', 'auth', ...args])
}

async function runAuthCommandWithRealRoot(args: string[] = []): Promise<void> {
  consoleLogs.length = 0
  const parent = new Command()
  parent.exitOverride()
  parent.enablePositionalOptions()
  parent.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  const auth = createAuthCommand()
  auth.exitOverride()
  parent.addCommand(auth)
  await parent.parseAsync(['node', 'test', ...args])
}

async function runAuthTest(args: string[] = [], parentConfig?: string): Promise<void> {
  await runAuthCommand(['test', ...args], parentConfig)
}

async function runAuthStatus(parentConfig?: string): Promise<void> {
  await runAuthCommand(['status'], parentConfig)
}

async function runAuthLogout(args: string[] = [], parentConfig?: string): Promise<void> {
  await runAuthCommand(['logout', ...args], parentConfig)
}

function getOutput(): string {
  return consoleLogs.join('\n')
}

function setNamedConfig(config: Record<string, unknown>): void {
  mockResolveNamedConfig.mockResolvedValue({
    config: config as any,
    allConfigs: [config as any],
    defaultName: String(config.name),
  })
}

const TEST_TOKENS = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: 1777675000000,
}

function createMockAuthPlugin(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'openai-subscription',
    credentialProviderId: 'openai-subscription-oauth',
    label: 'OpenAI subscription',
    modelAdapter: 'openai-responses',
    dashboardAuth: { mode: 'browser-poll', buttonLabel: 'Login with OpenAI subscription' },
    startAuth: vi.fn(async () => ({
      authorizeUrl: 'https://auth.example/openai',
      waitForTokens: Promise.resolve(TEST_TOKENS),
      cleanup: vi.fn(),
    })),
    exchangeCode: vi.fn(async () => TEST_TOKENS),
    createAuthFetch: vi.fn(() => globalThis.fetch),
    ...overrides,
  } as any
}

beforeEach(() => {
  process.exitCode = undefined
  mockGetLLMAuthProviderPlugin.mockReturnValue(undefined)
  mockInput.mockResolvedValue('auth-code')
})

describe('auth provider mode contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogs.length = 0
    mockCreateModel.mockReturnValue({} as any)
    mockGenerateText.mockResolvedValue({ text: 'ok' } as any)
    mockResolveCredentials.mockResolvedValue({ apiKey: 'test-key' })
    mockResolveModelAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'default',
      provider: 'openai-compatible',
      apiKey: 'test-key',
    })
    setNamedConfig({
      name: 'default',
      provider: 'openai-compatible',
      model: 'model-name',
      baseURL: 'https://remote.example/v1',
    })
    mockLoadConfigFile.mockResolvedValue({
      registry: {
        llms: [{
          name: 'default',
          provider: 'openai-compatible',
          model: 'model-name',
          baseURL: 'https://remote.example/v1',
        }],
      },
      use: { llm: 'default' },
    })
  })

  it('auth login rejects compatible and gemini configs with auth set guidance', async () => {
    mockResolveNamedConfig
      .mockResolvedValueOnce({
        config: {
          name: 'remote-anthropic',
          provider: 'anthropic-compatible',
          model: 'claude-remote',
          baseURL: 'https://remote.example/messages',
        },
        allConfigs: [],
        defaultName: 'remote-anthropic',
      })
      .mockResolvedValueOnce({
        config: { name: 'gemini-fast', provider: 'gemini', model: 'gemini-2.5-flash' },
        allConfigs: [],
        defaultName: 'gemini-fast',
      })

    await expect(runAuthCommand(['login', '--config', 'remote-anthropic'])).resolves.toBeUndefined()
    expect(getOutput()).toContain('agent-qa auth set --config <name> --type api-key')
    expect(getOutput()).toContain('--type bearer-token')

    await expect(runAuthCommand(['login', '--config', 'gemini-fast'])).resolves.toBeUndefined()
    expect(getOutput()).toContain('agent-qa auth set --config <name> --type api-key')
    expect(getOutput()).not.toContain(['openai', 'codex'].join('-'))
  })

  it('auth login reports missing subscription auth plugin guidance', async () => {
    mockResolveNamedConfig
      .mockResolvedValueOnce({
        config: { name: 'codex', provider: 'openai-subscription', model: 'gpt-5.3-codex' },
        allConfigs: [],
        defaultName: 'codex',
      })
      .mockResolvedValueOnce({
        config: { name: 'claude', provider: 'anthropic-subscription', model: 'claude-sonnet-4-20250514' },
        allConfigs: [],
        defaultName: 'claude',
    })

    await expect(runAuthCommand(['login', '--config', 'codex'])).resolves.toBeUndefined()
    expect(getOutput()).toContain('Provider "openai-subscription" is configured for "codex", but no auth plugin is registered.')
    expect(getOutput()).toContain('npm install -D @vostride/agent-qa-subscription-auth')
    expect(getOutput()).toContain('plugins.auth')
    expect(getOutput()).toContain('agent-qa dashboard')
    expect(getOutput()).not.toContain('requires an auth plugin')

    await expect(runAuthCommand(['login', '--config', 'claude'])).resolves.toBeUndefined()
    expect(getOutput()).toContain('Provider "anthropic-subscription" is configured for "claude", but no auth plugin is registered.')
    expect(getOutput()).toContain('npm install -D @vostride/agent-qa-subscription-auth')
    expect(getOutput()).toContain('plugins.auth')
    expect(getOutput()).toContain('agent-qa dashboard')
    expect(getOutput()).not.toContain('requires an auth plugin')

    expect(mockWriteAuth).not.toHaveBeenCalled()
    expect(getOutput()).not.toContain('authMethod')
  })

  it('auth login completes browser-poll plugin auth for Codex', async () => {
    const cleanup = vi.fn()
    const startAuth = vi.fn(async () => ({
      authorizeUrl: 'https://auth.example/openai',
      waitForTokens: Promise.resolve(TEST_TOKENS),
      cleanup,
    }))
    const plugin = createMockAuthPlugin({ startAuth })
    mockGetLLMAuthProviderPlugin.mockReturnValue(plugin)
    setNamedConfig({
      name: 'codex',
      provider: 'openai-subscription',
      model: 'gpt-5.3-codex',
    })

    await expect(runAuthCommand(['login', '--config', 'codex'])).resolves.toBeUndefined()

    expect(mockGetLLMAuthProviderPlugin).toHaveBeenCalledWith('openai-subscription')
    expect(startAuth).toHaveBeenCalledWith({ configName: 'codex' })
    expect(mockExec).toHaveBeenCalled()
    expect(mockWriteAuth).toHaveBeenCalledWith('codex', {
      type: 'oauth',
      provider: 'openai-subscription-oauth',
      tokens: TEST_TOKENS,
    })
    expect(cleanup).toHaveBeenCalled()
    expect(getOutput()).toContain('Open this URL to authenticate:')
    expect(getOutput()).toContain('Authenticated codex with OpenAI subscription')
    expect(getOutput()).not.toContain('requires an auth plugin')
  })

  it('auth login completes manual-code plugin auth for Claude subscription', async () => {
    const sessionState = { verifier: 'verifier-1' }
    const tokens = {
      access: 'anthropic-access-token',
      refresh: 'anthropic-refresh-token',
      expires: 1777675000000,
    }
    const startAuth = vi.fn(async () => ({
      authorizeUrl: 'https://auth.example/anthropic',
      sessionState,
    }))
    const exchangeCode = vi.fn(async () => tokens)
    const plugin = createMockAuthPlugin({
      providerId: 'anthropic-subscription',
      credentialProviderId: 'anthropic-subscription',
      label: 'Anthropic subscription',
      modelAdapter: 'anthropic-messages',
      dashboardAuth: { mode: 'manual-code', buttonLabel: 'Login with Anthropic subscription' },
      startAuth,
      exchangeCode,
    })
    mockGetLLMAuthProviderPlugin.mockReturnValue(plugin)
    setNamedConfig({
      name: 'claude-subscription',
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-20250514',
    })

    await expect(runAuthCommand(['login', '--config', 'claude-subscription'])).resolves.toBeUndefined()

    expect(startAuth).toHaveBeenCalledWith({ configName: 'claude-subscription' })
    expect(mockInput).toHaveBeenCalledWith({ message: 'Authorization code:' })
    expect(exchangeCode).toHaveBeenCalledWith({ code: 'auth-code', sessionState })
    expect(mockWriteAuth).toHaveBeenCalledWith('claude-subscription', {
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens,
    })
    expect(getOutput()).toContain('Authenticated claude-subscription with Anthropic subscription')
  })

  it('auth login guides to dashboard when manual-code plugin lacks exchangeCode', async () => {
    const plugin = createMockAuthPlugin({
      providerId: 'anthropic-subscription',
      credentialProviderId: 'anthropic-subscription',
      label: 'Anthropic subscription',
      modelAdapter: 'anthropic-messages',
      dashboardAuth: { mode: 'manual-code', buttonLabel: 'Login with Anthropic subscription' },
      startAuth: vi.fn(async () => ({
        authorizeUrl: 'https://auth.example/anthropic',
        sessionState: { verifier: 'verifier-1' },
      })),
      exchangeCode: undefined,
    })
    mockGetLLMAuthProviderPlugin.mockReturnValue(plugin)
    setNamedConfig({
      name: 'claude-subscription',
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-20250514',
    })

    await expect(runAuthCommand(['login', '--config', 'claude-subscription'])).resolves.toBeUndefined()

    expect(getOutput()).toContain('Provider "anthropic-subscription" does not support CLI code exchange. Use agent-qa dashboard.')
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('auth login parses local --config when the root command also has --config', async () => {
    setNamedConfig({
      name: 'codex',
      provider: 'openai-subscription',
      model: 'gpt-5.3-codex',
    })

    await expect(runAuthCommandWithRealRoot(['auth', 'login', '--config', 'codex'])).resolves.toBeUndefined()
    expect(mockResolveNamedConfig).toHaveBeenLastCalledWith('codex', 'agent-qa.config.yaml')
    expect(getOutput()).toContain('Provider "openai-subscription" is configured for "codex", but no auth plugin is registered.')

    mockResolveNamedConfig.mockClear()
    consoleLogs.length = 0
    await expect(runAuthCommandWithRealRoot(['--config', 'custom.yaml', 'auth', 'login', '--config', 'codex'])).resolves.toBeUndefined()
    expect(mockResolveNamedConfig).toHaveBeenLastCalledWith('codex', 'custom.yaml')
    expect(getOutput()).toContain('Provider "openai-subscription" is configured for "codex", but no auth plugin is registered.')
  })

  it('auth login requires a named subscription config and never writes provider-key fallback credentials', async () => {
    await expect(runAuthCommand(['login'])).rejects.toThrow('process.exit')
    await expect(runAuthCommand(['login', '--provider', 'openai-subscription'])).rejects.toThrow('process.exit')

    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('auth login rejects malformed resolved config names before OAuth writes', async () => {
    mockResolveNamedConfig.mockResolvedValueOnce({
      config: { name: ' codex ', provider: 'openai-subscription', model: 'gpt-5.3-codex' },
      allConfigs: [],
      defaultName: ' codex ',
    })

    await expect(runAuthCommand(['login', '--config', 'codex'])).resolves.toBeUndefined()

    expect(getOutput()).toContain('Config name is invalid')
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('auth set stores api-key credentials by config name', async () => {
    setNamedConfig({
      name: 'remote-openai',
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
    })

    await expect(
      runAuthCommand(['set', '--config', 'remote-openai', '--type', 'api-key', 'sk-remote']),
    ).resolves.toBeUndefined()

    expect(mockWriteAuth).toHaveBeenCalledWith('remote-openai', {
      type: 'api',
      provider: 'openai-compatible',
      key: 'sk-remote',
    })
    expect(getOutput()).toContain('Saved API key for remote-openai')
  })

  it('auth set stores bearer-token credentials by config name', async () => {
    setNamedConfig({
      name: 'remote-anthropic',
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://anthropic.example/messages',
    })

    await expect(
      runAuthCommand(['set', '--config', 'remote-anthropic', '--type', 'bearer-token', 'bearer-remote']),
    ).resolves.toBeUndefined()

    expect(mockWriteAuth).toHaveBeenCalledWith('remote-anthropic', {
      type: 'bearer',
      provider: 'anthropic-compatible',
      token: 'bearer-remote',
    })
    expect(getOutput()).toContain('Saved bearer token for remote-anthropic')
  })

  it('auth test reports compatible unauthenticated state neutrally', async () => {
    setNamedConfig({
      name: 'remote-anthropic',
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://remote.example/messages',
    })
    mockResolveModelAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'remote-anthropic',
      provider: 'anthropic-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    await runAuthTest(['--config', 'remote-anthropic'])

    expect(getOutput()).toContain('Testing without a saved credential.')
    expect(mockCreateModel).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic-compatible',
      baseURL: 'https://remote.example/messages',
    }))
    expect(mockGenerateText).toHaveBeenCalled()
  })

  it('auth test reports gemini missing saved credential', async () => {
    setNamedConfig({
      name: 'gemini-fast',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    })
    mockResolveModelAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'gemini-fast',
      provider: 'gemini',
      required: true,
      message: 'Save a Gemini API key for this config before testing.',
    })

    await runAuthTest(['--config', 'gemini-fast'])

    expect(getOutput()).toContain('Save a Gemini API key for this config before testing.')
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('auth status lists config-name credential states', async () => {
    mockLoadConfigFile.mockResolvedValue({
      registry: {
        llms: [
          { name: 'remote-openai', provider: 'openai-compatible', model: 'openrouter/auto' },
          { name: 'remote-anthropic', provider: 'anthropic-compatible', model: 'claude-remote' },
          { name: 'gemini-fast', provider: 'gemini', model: 'gemini-2.5-flash' },
          { name: 'codex', provider: 'openai-subscription', model: 'gpt-5.3-codex' },
          { name: 'claude', provider: 'anthropic-subscription', model: 'claude-sonnet-4-20250514' },
          { name: 'expired-claude', provider: 'anthropic-subscription', model: 'claude-sonnet-4-20250514' },
          { name: 'optional-openai', provider: 'openai-compatible', model: 'openrouter/auto' },
        ],
      },
      use: { llm: 'remote-openai' },
    })
    mockResolveModelAuth.mockImplementation(async (name: string, llm: { provider: string }) => {
      if (name === 'remote-openai') {
        return { kind: 'api-key', credentialKey: name, provider: 'openai-compatible', apiKey: 'sk-openai' } as any
      }
      if (name === 'remote-anthropic') {
        return { kind: 'bearer-token', credentialKey: name, provider: 'anthropic-compatible', token: 'bearer-anthropic' } as any
      }
      if (name === 'codex') {
        return { kind: 'auth-fetch', credentialKey: name, provider: 'openai-subscription', fetch: vi.fn(), expires: Date.now() + 3600000 } as any
      }
      if (name === 'expired-claude') {
        return { kind: 'auth-fetch', credentialKey: name, provider: 'anthropic-subscription', fetch: vi.fn(), expires: Date.now() - 1000 } as any
      }
      if (llm.provider === 'openai-compatible' || llm.provider === 'anthropic-compatible') {
        return { kind: 'unauthenticated', credentialKey: name, provider: llm.provider, optional: true, message: 'Testing without a saved credential.' } as any
      }
      return { kind: 'missing', credentialKey: name, provider: llm.provider, required: true, message: 'missing' } as any
    })

    await runAuthStatus()
    const output = getOutput()

    expect(output).toContain('remote-openai')
    expect(output).toContain('remote-anthropic')
    expect(output).toContain('gemini-fast')
    expect(output).toContain('codex')
    expect(output).toContain('claude')
    expect(output).toContain('OpenAI-compatible')
    expect(output).toContain('Anthropic-compatible')
    expect(output).toContain('OpenAI subscription')
    expect(output).toContain('Anthropic subscription')
    expect(output).toContain('Saved API key')
    expect(output).toContain('Saved bearer token')
    expect(output).toContain('OAuth connected')
    expect(output).toContain('No credential')
    expect(output).toContain('Missing credential')
    expect(output).toContain('Expired')
    expect(output).toContain('(default)')
  })

  it('uses the parent global config path for config-centric auth commands', async () => {
    setNamedConfig({
      name: 'remote-openai',
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
    })

    await runAuthCommand(
      ['set', '--config', 'remote-openai', '--type', 'api-key', 'sk-remote'],
      'custom-agent-qa.yaml',
    )
    expect(mockResolveNamedConfig).toHaveBeenLastCalledWith('remote-openai', 'custom-agent-qa.yaml')

    mockResolveNamedConfig.mockClear()
    await runAuthTest(['--config', 'remote-openai'], 'custom-agent-qa.yaml')
    expect(mockResolveNamedConfig).toHaveBeenLastCalledWith('remote-openai', 'custom-agent-qa.yaml')

    mockResolveNamedConfig.mockClear()
    setNamedConfig({
      name: 'codex',
      provider: 'openai-subscription',
      model: 'gpt-5.3-codex',
    })
    await runAuthCommand(['login', '--config', 'codex'], 'custom-agent-qa.yaml')
    expect(mockResolveNamedConfig).toHaveBeenLastCalledWith('codex', 'custom-agent-qa.yaml')

    await runAuthStatus('custom-agent-qa.yaml')
    expect(mockLoadConfigFile).toHaveBeenLastCalledWith('custom-agent-qa.yaml')
  })

  it('auth logout deletes by config name', async () => {
    await runAuthLogout(['--config', 'remote-anthropic'])

    expect(mockRemoveAuth).toHaveBeenCalledWith('remote-anthropic')
    expect(getOutput()).toContain('Logged out from remote-anthropic')
  })
})

describe('auth set', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogs.length = 0
  })

  it('prompts for secret when omitted', async () => {
    setNamedConfig({
      name: 'gemini-fast',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    })

    await runAuthCommand(['set', '--config', 'gemini-fast', '--type', 'api-key'])

    expect(mockPassword).toHaveBeenCalledWith({ message: 'Secret:' })
    expect(mockWriteAuth).toHaveBeenCalledWith('gemini-fast', {
      type: 'api',
      provider: 'gemini',
      key: 'prompt-secret',
    })
  })

  it('rejects bearer-token credentials for non anthropic-compatible configs', async () => {
    setNamedConfig({
      name: 'remote-openai',
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
    })

    await runAuthCommand(['set', '--config', 'remote-openai', '--type', 'bearer-token', 'bearer-remote'])

    expect(getOutput()).toContain('bearer-token credentials are only supported for anthropic-compatible configs')
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('rejects api-key credentials for subscription configs', async () => {
    setNamedConfig({
      name: 'claude-subscription',
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-20250514',
    })

    await runAuthCommand(['set', '--config', 'claude-subscription', '--type', 'api-key', 'sk-not-allowed'])

    expect(getOutput()).toContain('Subscription providers use OAuth login')
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })
})

describe('auth test', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogs.length = 0
    mockCreateModel.mockReturnValue({} as any)
    mockGenerateText.mockResolvedValue({ text: 'ok' } as any)
    setNamedConfig({
      name: 'default',
      provider: 'openai-compatible',
      model: 'model-name',
      baseURL: 'https://remote.example/v1',
      providerHeaders: { 'x-workspace': 'agent-qa' },
    })
    mockResolveModelAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'default',
      provider: 'openai-compatible',
      apiKey: 'test-key',
    })
    mockResolveLLMModels.mockReturnValue({
      planner: { provider: 'openai-compatible', model: 'model-name', baseURL: 'https://remote.example/v1' },
      verifier: { provider: 'openai-compatible', model: 'model-name', baseURL: 'https://remote.example/v1' },
      configName: 'default',
    })
  })

  it('uses resolver output and passes runtime auth material into createModel', async () => {
    mockResolveModelAuth.mockResolvedValue({
      kind: 'bearer-token',
      credentialKey: 'default',
      provider: 'anthropic-compatible',
      token: 'bearer-default',
    })
    setNamedConfig({
      name: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://anthropic.example/messages',
      providerHeaders: { 'x-workspace': 'agent-qa' },
    })

    await runAuthTest()

    expect(mockResolveModelAuth).toHaveBeenCalledWith('default', expect.objectContaining({
      provider: 'anthropic-compatible',
      providerHeaders: { 'x-workspace': 'agent-qa' },
    }))
    expect(mockCreateModel).toHaveBeenCalledWith({
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://anthropic.example/messages',
      providerHeaders: { 'x-workspace': 'agent-qa' },
      authToken: 'bearer-default',
    })
  })

  it('blocks subscription tests when resolver reports missing OAuth', async () => {
    setNamedConfig({
      name: 'codex',
      provider: 'openai-subscription',
      model: 'gpt-5.3-codex',
    })
    mockResolveModelAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'codex',
      provider: 'openai-subscription',
      required: true,
      message: 'Login with OpenAI subscription for this config before testing.',
    })

    await runAuthTest(['--config', 'codex'])

    expect(getOutput()).toContain('Login with OpenAI subscription for this config before testing.')
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('prints config credential auth error copy', async () => {
    mockGenerateText.mockRejectedValue(new Error('401 Unauthorized'))

    await runAuthTest()

    expect(getOutput()).toContain('Authentication failed. Check the saved credential for this config.')
  })

  it('--provider and --model flags override config values for resolver and model creation', async () => {
    await runAuthTest(['--provider', 'gemini', '--model', 'gemini-2.5-flash'])

    expect(mockResolveModelAuth).toHaveBeenCalledWith('default', expect.objectContaining({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    }))
    expect(mockCreateModel).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    }))
  })
})

describe('auth status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogs.length = 0
    mockLoadConfigFile.mockResolvedValue({
      registry: {
        llms: [
          { name: 'default', provider: 'openai-compatible', model: 'model-name' },
        ],
      },
      use: { llm: 'default' },
    })
  })

  it('does not advertise orphaned provider fallback credentials as usable', async () => {
    mockResolveModelAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'default',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    await runAuthStatus()

    const output = getOutput()
    expect(output).toContain('default')
    expect(output).toContain('No credential')
    expect(output).not.toContain('Other credentials')
    expect(output).not.toContain('sk-shared')
    expect(output).not.toContain('Saved API key')
  })

  it('shows no configured LLMs when config has no llms', async () => {
    mockLoadConfigFile.mockResolvedValue({})

    await runAuthStatus()

    expect(getOutput()).toContain('No LLM configs found')
  })
})

describe('auth logout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogs.length = 0
    setNamedConfig({
      name: 'default',
      provider: 'openai-compatible',
      model: 'model-name',
      baseURL: 'https://remote.example/v1',
    })
  })

  it('no flags calls removeAuth with default config name', async () => {
    await runAuthLogout()
    expect(mockRemoveAuth).toHaveBeenCalledWith('default')
    expect(getOutput()).toContain('Logged out from default')
  })

  it('errors when no flags and no config file', async () => {
    mockResolveNamedConfig.mockRejectedValue(new Error('No LLM configs found'))

    await runAuthLogout()

    expect(getOutput()).toContain('Specify --config')
  })
})
