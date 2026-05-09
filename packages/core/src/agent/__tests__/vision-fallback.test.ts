import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScreenState } from '../../types/platform.js'
import type { StepContext, PlannerConfig } from '../types.js'
import type { LanguageModel } from 'ai'

const mockGenerateText = vi.fn()

vi.mock('ai', () => ({
  generateText: (...args: any[]) => mockGenerateText(...args),
  tool: vi.fn((config: any) => config),
  jsonSchema: vi.fn((schema: any) => schema),
  wrapLanguageModel: vi.fn(({ model }: any) => model),
}))

// Import after mock setup
const { LLMPlanner } = await import('../planner.js')

function makeScreenState(): ScreenState {
  return {
    tree: 'button "Sign In" [ref=btn-1]',
    elements: [{ ref: 'btn-1', role: 'button', name: 'Sign In', attributes: {} }],
    url: 'https://example.com/login',
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
  }
}

function makePlannerConfig(overrides?: Partial<PlannerConfig>): PlannerConfig {
  return {
    maxSubActions: 10,
    previousStepCount: 5,
    ...overrides,
  }
}

function makeStepContext(overrides?: Partial<StepContext>): StepContext {
  return {
    stepInstruction: 'Click the Sign In button',
    testName: 'Login test',
    previousSteps: [],
    plannerModel: {} as LanguageModel,
    verifierModel: {} as LanguageModel,
    healingConfig: { maxAttempts: 3 },
    ...overrides,
  }
}

// Mock tool call result — LLM calls the 'click' tool
const validToolCallResult = {
  toolCalls: [{
    toolName: 'click',
    args: {
      reasoning: 'Click the sign in button',
      ref: 'btn-1',
      confidence: 0.9,
      stepComplete: false,
    },
  }],
  usage: { inputTokens: 100, outputTokens: 50 },
}

const expectedPlan = {
  action: { type: 'click', ref: 'btn-1' },
  reasoning: 'Click the sign in button',
  confidence: 0.9,
  stepComplete: false,
  stepFailed: false,
}

function makeMockModel(): LanguageModel {
  return {
    modelId: 'test-model',
    specificationVersion: 'v1',
    provider: 'openai',
    defaultObjectGenerationMode: 'json',
  } as unknown as LanguageModel
}

describe('LLMPlanner vision fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateText.mockResolvedValue(validToolCallResult)
  })

  it('uses text-only prompt when no screenshot in context', async () => {
    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext()

    await planner.plan('Click sign in', makeScreenState(), context)

    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const callArgs = mockGenerateText.mock.calls[0][0]
    expect(callArgs.prompt).toBeDefined()
    expect(callArgs.messages).toBeUndefined()
    expect(callArgs.tools).toBeDefined()
    expect(callArgs.toolChoice).toBe('required')
  })

  it('uses messages format when screenshot is provided', async () => {
    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext({
      screenshot: Buffer.from('fake-png'),
      plannerConfig: makePlannerConfig(),
    })

    await planner.plan('Click sign in', makeScreenState(), context)

    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const callArgs = mockGenerateText.mock.calls[0][0]
    expect(callArgs.messages).toBeDefined()
    expect(callArgs.messages[0].content).toHaveLength(2)
    expect(callArgs.messages[0].content[0].type).toBe('text')
    expect(callArgs.messages[0].content[1].type).toBe('image')
    expect(callArgs.messages[0].content[1].image).toEqual(Buffer.from('fake-png'))
  })

  it('falls back to text-only on vision error', async () => {
    mockGenerateText
      .mockRejectedValueOnce(new Error('Model does not support image input'))
      .mockResolvedValueOnce(validToolCallResult)

    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext({
      screenshot: Buffer.from('fake-png'),
      plannerConfig: makePlannerConfig(),
    })

    const result = await planner.plan('Click sign in', makeScreenState(), context)

    expect(mockGenerateText).toHaveBeenCalledTimes(2)

    // First call: multimodal with messages
    const firstCall = mockGenerateText.mock.calls[0][0]
    expect(firstCall.messages).toBeDefined()

    // Second call: text-only fallback with prompt
    const secondCall = mockGenerateText.mock.calls[1][0]
    expect(secondCall.prompt).toBeDefined()
    expect(secondCall.messages).toBeUndefined()
    expect(secondCall.prompt).toContain('[Note: Visual screenshot is unavailable for this step.')

    expect(result.plan).toEqual(expectedPlan)
  })

  it('does not send screenshot when screenshot buffer absent from context', async () => {
    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext({
      plannerConfig: makePlannerConfig(),
    })

    await planner.plan('Click sign in', makeScreenState(), context)

    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const callArgs = mockGenerateText.mock.calls[0][0]
    expect(callArgs.prompt).toBeDefined()
    expect(callArgs.messages).toBeUndefined()
  })

  it('logs warning on vision fallback via scoped logger', async () => {
    const warnSpy = vi.fn()
    const mockLogger = { warn: warnSpy, info: vi.fn(), debug: vi.fn(), error: vi.fn() }

    mockGenerateText
      .mockRejectedValueOnce(new Error('Vision not supported'))
      .mockResolvedValueOnce(validToolCallResult)

    const planner = new LLMPlanner(makeMockModel(), 'web', undefined, mockLogger as any)
    const context = makeStepContext({
      screenshot: Buffer.from('fake-png'),
      plannerConfig: makePlannerConfig(),
    })

    await planner.plan('Click sign in', makeScreenState(), context)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('retrying without image'),
      expect.any(Object),
    )
  })

  it('sends screenshot even when plannerConfig is undefined', async () => {
    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext({
      screenshot: Buffer.from('fake-png'),
      // no plannerConfig — screenshot is always sent when present
    })

    await planner.plan('Click sign in', makeScreenState(), context)

    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const callArgs = mockGenerateText.mock.calls[0][0]
    expect(callArgs.messages).toBeDefined()
    expect(callArgs.messages[0].content[1].type).toBe('image')
  })

  it('sends screenshot without imageProviderOptions', async () => {
    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext({
      screenshot: Buffer.from('fake-png'),
      plannerConfig: makePlannerConfig(),
    })

    await planner.plan('Click sign in', makeScreenState(), context)

    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const callArgs = mockGenerateText.mock.calls[0][0]
    const imagePart = callArgs.messages[0].content[1]
    expect(imagePart.type).toBe('image')
    expect(imagePart.providerOptions).toBeUndefined()
  })

  it('uses text-only path when no screenshot in context', async () => {
    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext({
      plannerConfig: makePlannerConfig(),
    })

    await planner.plan('Click sign in', makeScreenState(), context)

    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const callArgs = mockGenerateText.mock.calls[0][0]
    expect(callArgs.prompt).toBeDefined()
    expect(callArgs.messages).toBeUndefined()
  })

  it('propagates error when text-only fallback also fails', async () => {
    mockGenerateText
      .mockRejectedValueOnce(new Error('Vision not supported'))
      .mockRejectedValueOnce(new Error('Rate limit exceeded'))

    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext({
      screenshot: Buffer.from('fake-png'),
      plannerConfig: makePlannerConfig(),
    })

    // Suppress console.log from vision fallback
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      planner.plan('Click sign in', makeScreenState(), context),
    ).rejects.toThrow('Rate limit exceeded')

    vi.restoreAllMocks()
  })

  it('throws when LLM does not call any tool', async () => {
    mockGenerateText.mockResolvedValue({
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50 },
    })

    const planner = new LLMPlanner(makeMockModel())
    const context = makeStepContext()

    await expect(
      planner.plan('Click sign in', makeScreenState(), context),
    ).rejects.toThrow('LLM did not call any action tool')
  })

  it('filters mobile-only tools for web platform', async () => {
    const planner = new LLMPlanner(makeMockModel(), 'web')
    const context = makeStepContext()

    await planner.plan('Click sign in', makeScreenState(), context)

    const callArgs = mockGenerateText.mock.calls[0][0]
    const toolNames = Object.keys(callArgs.tools)
    expect(toolNames).toContain('click')
    expect(toolNames).toContain('scroll')
    expect(toolNames).not.toContain('tap')
    expect(toolNames).not.toContain('swipe')
    expect(toolNames).not.toContain('pinch')
    expect(toolNames).not.toContain('multiTap')
  })

  it('filters web-only tools for mobile platform', async () => {
    const planner = new LLMPlanner(makeMockModel(), 'android')
    const context = makeStepContext()

    await planner.plan('Click sign in', makeScreenState(), context)

    const callArgs = mockGenerateText.mock.calls[0][0]
    const toolNames = Object.keys(callArgs.tools)
    expect(toolNames).toContain('tap')
    expect(toolNames).toContain('pinch')
    expect(toolNames).toContain('multiTap')
    expect(toolNames).not.toContain('hover')
  })
})
