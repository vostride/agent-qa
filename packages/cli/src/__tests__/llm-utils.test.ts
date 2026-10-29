import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest'

// The secret loader reads core's workspace paths and config merge, so mocks keep the module.
vi.mock('@vostride/agent-qa-core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCredential: vi.fn(),
  resolveLLMAuth: vi.fn(),
  writeAuth: vi.fn(() => Promise.resolve()),
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfigFile: vi.fn(),
}))

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getCredential, resolveLLMAuth } from '@vostride/agent-qa-core'
import { generateText as sdkGenerateText } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { createModel } from '@vostride/agent-qa-model'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { loadConfigFile } from '../config.js'
import {
  applyResolvedAuthToModelConfig,
  buildAnalysisTokenBudget,
  buildJobModelCapability,
  resolveCliChatCapabilities,
  resolveCliJobModel,
  resolveLLMModels,
  resolveCredentials,
  resolveModelAuth,
  resolveNamedConfig,
} from '../llm-utils.js'

import type { JobModelCapabilityDeps } from '../llm-utils.js'
import type { ModelCapabilities } from '@vostride/agent-qa-schema'
import type { ModelProfile, ResolvedModelAuth } from '@vostride/agent-qa-model'
import type { generateText } from 'ai'

const mockGetCredential = vi.mocked(getCredential)
const mockResolveLLMAuth = vi.mocked(resolveLLMAuth)
const mockLoadConfigFile = vi.mocked(loadConfigFile)

const PROVIDER_MODES = [
  'openai-compatible',
  'anthropic-compatible',
  'openai-subscription',
  'anthropic-subscription',
  'gemini',
] as const

const DECOY_FALLBACK_KEYS = [
  'anthropic-compatible',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_KEY',
  'remote.example',
] as const

describe('resolveCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads named configs from the provided config path', async () => {
    mockLoadConfigFile.mockResolvedValueOnce({
      registry: {
        llms: [{
          name: 'planner',
          provider: 'openai-compatible',
          model: 'deepseek-chat',
          baseURL: 'https://remote.example/api/v1',
        }],
      },
      use: { llm: 'planner' },
    })

    const resolved = await resolveNamedConfig(undefined, 'custom-agent-qa.yaml')

    expect(mockLoadConfigFile).toHaveBeenCalledWith('custom-agent-qa.yaml')
    expect(resolved.config).toMatchObject({
      name: 'planner',
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
    })
  })

  it('resolves model auth through the core resolver with the named config', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      apiKey: 'sk-planner',
    })

    const auth = await resolveModelAuth('planner', {
      provider: 'openai-compatible',
      model: 'gpt-4.1',
      baseURL: 'https://remote.example/api/v1',
    })

    expect(auth).toEqual(expect.objectContaining({
      kind: 'api-key',
      credentialKey: 'planner',
      apiKey: 'sk-planner',
    }))
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('planner', {
      provider: 'openai-compatible',
      model: 'gpt-4.1',
      baseURL: 'https://remote.example/api/v1',
    })
  })

  it('applies bearer tokens and providerHeaders to runtime model config without apiKey', () => {
    const runtimeConfig = applyResolvedAuthToModelConfig(
      {
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic.example/messages',
        providerHeaders: { 'x-workspace': 'agent-qa' },
      },
      {
        kind: 'bearer-token',
        credentialKey: 'planner',
        provider: 'anthropic-compatible',
        token: 'bearer-planner',
      },
    )

    expect(runtimeConfig).toEqual({
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://anthropic.example/messages',
      providerHeaders: { 'x-workspace': 'agent-qa' },
      authToken: 'bearer-planner',
    })
    expect(runtimeConfig).not.toHaveProperty('apiKey')
  })

  it('throws resolver missing messages before model config creation', () => {
    expect(() => applyResolvedAuthToModelConfig(
      {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
      },
      {
        kind: 'missing',
        credentialKey: 'gemini-fast',
        provider: 'gemini',
        required: true,
        message: 'Save a Gemini API key for this config before testing.',
      },
    )).toThrow('Save a Gemini API key for this config before testing.')
  })

  it.each(PROVIDER_MODES)('resolves %s credentials through core resolveLLMAuth by config name only', async (provider) => {
    const authFetch = vi.fn() as unknown as typeof globalThis.fetch
    mockResolveLLMAuth.mockResolvedValue(
      provider === 'anthropic-compatible'
        ? {
            kind: 'bearer-token',
            credentialKey: 'planner',
            provider: 'anthropic-compatible',
            token: 'bearer-planner',
          }
        : provider.endsWith('-subscription')
          ? {
              kind: 'auth-fetch',
              credentialKey: 'planner',
              provider: provider as 'openai-subscription' | 'anthropic-subscription',
              modelAdapter: provider === 'openai-subscription' ? 'openai-responses' : 'anthropic-messages',
              fetch: authFetch,
            }
          : provider === 'gemini'
            ? {
                kind: 'api-key',
                credentialKey: 'planner',
                provider,
                apiKey: 'gemini-planner',
              }
            : {
                kind: 'api-key',
                credentialKey: 'planner',
                provider,
                apiKey: 'sk-planner',
              },
    )

    await resolveCredentials('planner', {
      provider,
      baseURL: provider.includes('compatible') ? 'https://remote.example/api/v1' : undefined,
    } as any)

    expect(mockResolveLLMAuth).toHaveBeenCalledWith(
      'planner',
      expect.objectContaining({ provider }),
    )
    expect(mockGetCredential).not.toHaveBeenCalledWith(expect.not.stringMatching(/^planner$/))
  })

  it('does not query provider env or host fallback credential keys', async () => {
    mockGetCredential.mockImplementation(async (name: string) => {
      if ((DECOY_FALLBACK_KEYS as readonly string[]).includes(name)) {
        return { type: 'api' as const, provider: 'openai-compatible', key: 'sk-shared' }
      }
      return null
    })
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    const result = await resolveCredentials('planner', {
      provider: 'anthropic-compatible',
      baseURL: 'https://remote.example/api/v1',
    } as any)

    expect(result).toEqual({})
    for (const decoy of DECOY_FALLBACK_KEYS) {
      expect(mockGetCredential).not.toHaveBeenCalledWith(decoy)
    }
  })
})

describe('resolveLLMModels', () => {
  it('uses the current Claude fallback when config has no selected LLM', () => {
    const resolved = resolveLLMModels({})

    expect(resolved.configName).toBe('')
    expect(resolved.planner).toEqual({
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-5-5',
    })
    expect(resolved.verifier).toEqual({
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-5-5',
    })
  })

  it('uses the current Claude fallback when the selected LLM is missing', () => {
    const resolved = resolveLLMModels({
      registry: {
        llms: [{
          name: 'configured',
          provider: 'openai-compatible',
          model: 'deepseek-chat',
          baseURL: 'https://remote.example/api/v1',
        }],
      },
      use: { llm: 'missing' },
    })

    expect(resolved.configName).toBe('')
    expect(resolved.planner.model).toBe('claude-sonnet-5-5')
    expect(resolved.verifier.model).toBe('claude-sonnet-5-5')
  })

  it('preserves explicit named model configs', () => {
    const resolved = resolveLLMModels({
      registry: {
        llms: [{
          name: 'configured',
          provider: 'openai-compatible',
          model: 'deepseek-chat',
          baseURL: 'https://remote.example/api/v1',
        }],
      },
      use: { llm: 'configured' },
    })

    expect(resolved.configName).toBe('configured')
    expect(resolved.planner).toEqual({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
    })
    expect(resolved.verifier).toEqual(resolved.planner)
  })
})

const BUDGET_CAPABILITIES: ModelCapabilities = {
  text: true,
  vision: false,
  visionToolMessages: false,
  toolCalling: false,
  structuredOutput: false,
  streaming: false,
  contextWindow: 1_000,
  maxOutput: 200,
}

const JOB_PROFILE: ModelProfile = {
  provider: 'openai-compatible',
  model: 'job-model',
  auth: { mode: 'none' },
}

const NONE_AUTH: ResolvedModelAuth = { kind: 'none' }

function visionDeps(vision: boolean): {
  calls: Record<string, unknown>[]
  resolveCalls: ModelProfile[]
  deps: JobModelCapabilityDeps
} {
  const calls: Record<string, unknown>[] = []
  const resolveCalls: ModelProfile[] = []
  return {
    calls,
    resolveCalls,
    deps: {
      createModelImpl: (() => ({})) as unknown as typeof createModel,
      resolveCapabilitiesImpl: (profile: ModelProfile) => {
        resolveCalls.push(profile)
        return { ...BUDGET_CAPABILITIES, vision }
      },
      generateTextImpl: (async (args: Record<string, unknown>) => {
        calls.push(args)
        return { text: 'answered' }
      }) as unknown as typeof generateText,
    },
  }
}

describe('buildAnalysisTokenBudget', () => {
  it('derives estimate and inputBudget from the SAME profile resolution as the model capability', () => {
    const { resolveCalls, deps } = visionDeps(false)

    const budget = buildAnalysisTokenBudget(JOB_PROFILE, deps)
    buildJobModelCapability(JOB_PROFILE, NONE_AUTH, (text) => text, deps)

    // One source of truth: both builders consulted the capability resolver with the
    // IDENTICAL profile object — no second config, no re-spelled ceiling.
    expect(resolveCalls.length).toBeGreaterThanOrEqual(2)
    for (const seen of resolveCalls) expect(seen).toBe(JOB_PROFILE)

    // The input budget is the context window minus the output reservation the SAME
    // accounting charges the model call with.
    expect(budget.inputBudget).toBe(1_000 - 200)
    // The estimator is the accounting's own (chars/4 over one text part).
    expect(budget.estimate('a'.repeat(400))).toBe(100)
  })
})

describe('buildJobModelCapability vision', () => {
  const IMAGE_A = new Uint8Array([1, 2, 3])
  const IMAGE_B = new Uint8Array([4, 5, 6])

  it('surfaces vision from the same resolveCapabilities the accounting consults', () => {
    expect(buildJobModelCapability(JOB_PROFILE, NONE_AUTH, (text) => text, visionDeps(true).deps).vision).toBe(true)
    expect(buildJobModelCapability(JOB_PROFILE, NONE_AUTH, (text) => text, visionDeps(false).deps).vision).toBe(false)
  })

  it('attaches image parts through the messages form when the gate allows', async () => {
    const { calls, deps } = visionDeps(true)
    const capability = buildJobModelCapability(JOB_PROFILE, NONE_AUTH, (text) => text, deps)

    await capability.generate({ system: 'sys', prompt: 'explain', images: [IMAGE_A, IMAGE_B] })

    expect(calls).toHaveLength(1)
    const args = calls[0]!
    // The verifier turn-message precedent: ONE user message, one text part (the prompt)
    // plus one image part per entry; system unchanged; the prompt form absent.
    expect(args.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'explain' },
          { type: 'image', image: IMAGE_A },
          { type: 'image', image: IMAGE_B },
        ],
      },
    ])
    expect(args).not.toHaveProperty('prompt')
    expect(args.system).toBe('sys')
    expect(args).toMatchObject({ maxRetries: 0, temperature: 0, maxOutputTokens: 200 })
  })

  it('strips images to the byte-identical text call against a text-only model', async () => {
    const { calls, deps } = visionDeps(false)
    const capability = buildJobModelCapability(JOB_PROFILE, NONE_AUTH, (text) => text, deps)

    await capability.generate({ prompt: 'explain', images: [IMAGE_A] })
    await capability.generate({ prompt: 'explain' })

    // Enforced at the host boundary: a mis-gated caller's images strip to the plain text call.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0]).not.toHaveProperty('messages')
    expect(calls[0]).toHaveProperty('prompt', 'explain')
  })

  it('keeps text-only requests byte-identical to the pre-vision call shape', async () => {
    const { calls, deps } = visionDeps(true)
    const capability = buildJobModelCapability(JOB_PROFILE, NONE_AUTH, (text) => text, deps)

    await capability.generate({ system: 'sys', prompt: 'explain' })

    expect(calls[0]).toEqual({
      model: {},
      maxRetries: 0,
      temperature: 0,
      maxOutputTokens: 200,
      system: 'sys',
      prompt: 'explain',
    })
  })
})

describe('the daemon egress mechanism (verified parity)', () => {
  it("passes createModel's pinned-last masking seam with NO active scope — the daemon posture", async () => {
    // The daemon pumps outside any scope; the seam is the declared mask the job capability takes.
    const secret = 'sk-live-abcdef0123456789'
    const redactor = new SecretRedactor(SecretStore.fromEnvContent(`DAEMON_KEY_441=${secret}`))
    let captured: { prompt?: { role: string; content: { type: string; text?: string }[] }[] } | undefined

    const capturingCreateModel: typeof createModel = (profile, auth, mask) =>
      createModel(profile, auth, mask, {
        languageModels: {
          'job-model': {
            specificationVersion: 'v3',
            provider: 'stub',
            modelId: 'stub',
            supportedUrls: {},
            async doGenerate(params: unknown) {
              captured = params as typeof captured
              return {
                content: [],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 0, text: 0, reasoning: 0 },
                },
                warnings: [],
              }
            },
            async doStream() {
              return { stream: new ReadableStream() }
            },
          } as never,
        },
      })

    const capability = buildJobModelCapability(
      { ...JOB_PROFILE, baseURL: 'http://localhost:11434/v1' },
      NONE_AUTH,
      (text) => redactor.redactString(text),
      { createModelImpl: capturingCreateModel },
    )

    await capability.generate({ prompt: `use ${secret}` })

    const text = captured?.prompt
      ?.find((message) => message.role === 'user')
      ?.content.find((part) => part.type === 'text')?.text
    expect(text).toContain('[secret:DAEMON_KEY_441]')
    expect(text).not.toContain(secret)
  })

  it('the daemon binding rides the same scoped builder (source pin)', () => {
    const source = readFileSync(new URL('../commands/daemon.ts', import.meta.url), 'utf8')
    expect(source).toContain('resolveCliJobModel(configPath)')
    expect(source).toContain('resolveCliAnalysisTokenBudget')
  })

  it('the CLI host supplies the budget beside the model binding (source pin)', () => {
    const source = readFileSync(
      new URL('../composition/local-agent-host.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain('resolveCliAnalysisTokenBudget')
  })
})

describe('model egress masking', () => {
  const roots: string[] = []

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  function declaredProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-441-egress-'))
    roots.push(root)
    const llm = {
      name: 'planner',
      provider: 'openai-compatible',
      model: 'egress-model',
      baseURL: 'http://localhost:11434/v1',
    }
    const configPath = join(root, 'agent-qa.config.yaml')
    writeFileSync(configPath, [
      'workspace:',
      "  testMatch: ['tests/**/*.yaml']",
      "  suiteMatch: ['suites/**/*.yaml']",
      '  hooksFile: hooks.yaml',
      '  envFile: .env.local',
      '  secretsFile: .secrets.local',
      'registry:',
      '  llms:',
      `    - name: ${llm.name}`,
      `      provider: ${llm.provider}`,
      `      model: ${llm.model}`,
      `      baseURL: ${llm.baseURL}`,
      'use:',
      '  llm: planner',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'hooks.yaml'), '')
    writeFileSync(join(root, '.env.local'), '')
    writeFileSync(join(root, '.secrets.local'), 'SHORT=q^7\n')
    mockLoadConfigFile.mockResolvedValue({ registry: { llms: [llm] }, use: { llm: 'planner' } })
    mockResolveLLMAuth.mockResolvedValue({ kind: 'unauthenticated' } as never)
    return configPath
  }

  function recordingImpl() {
    const recorder = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    })
    const createModelImpl: typeof createModel = (profile, auth, mask) =>
      createModel(profile, auth, mask, { languageModels: { [profile.model]: recorder } })
    const sentUserText = () => JSON.stringify(
      recorder.doGenerateCalls[0]?.prompt.filter(message => message.role === 'user'),
    )
    return { createModelImpl, sentUserText }
  }

  it('the chat model sends a declared value as its named marker', async () => {
    const configPath = declaredProject()
    const { createModelImpl, sentUserText } = recordingImpl()

    const capabilities = await resolveCliChatCapabilities(configPath, { createModelImpl })
    expect(capabilities).toBeDefined()
    await sdkGenerateText({
      model: capabilities!.model as Parameters<typeof sdkGenerateText>[0]['model'],
      messages: [{ role: 'user', content: 'Type q^7 into the code field.' }],
    })

    expect(sentUserText()).toContain('Type [secret:SHORT] into the code field.')
    expect(sentUserText()).not.toContain('q^7')
  })

  it('the job model masks with the same loader', async () => {
    const configPath = declaredProject()
    const { createModelImpl, sentUserText } = recordingImpl()

    const capability = await resolveCliJobModel(configPath, { createModelImpl })
    await capability.generate({ prompt: 'Type q^7 into the code field.' })

    expect(sentUserText()).toContain('Type [secret:SHORT] into the code field.')
    expect(sentUserText()).not.toContain('q^7')
  })
})
