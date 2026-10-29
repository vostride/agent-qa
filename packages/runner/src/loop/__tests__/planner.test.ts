// Unit tests for the runner-owned LLMPlanner (353-02 Task 1, D-02). Ported from v1's
// scripted-fake-LanguageModel pattern: a mocked `ai.generateText` returns a scripted
// tool call and the planner projects it into a PlanResult. `tool` stays real (only
// generateText is replaced) so buildTools produces the true v45 slice. Behaviors:
//   1. a scripted tool-call response → PlanResult with the parsed ActionPlan envelope
//   2. screenshot send failure → retry once without the image, prompt annotated
//   3. arg extraction tolerates the args/input SDK key variants
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScreenState } from '@vostride/agent-qa-schema'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import type { StepContext } from '../types.js'
import type { LoopScopedLogger } from '../ports.js'
import { LLMPlanner } from '../planner.js'
import { makeFakeTokenAccounting } from './loop-harness.js'

// A capturing LoopScopedLogger spy — records every warn/error call so a test can assert what
// meta the planner surfaced for a swallowed provider error.
interface LoggedCall { message: string; meta?: Record<string, unknown> }
function makeSpyLogger(): LoopScopedLogger & { warnCalls: LoggedCall[]; errorCalls: LoggedCall[] } {
  const warnCalls: LoggedCall[] = []
  const errorCalls: LoggedCall[] = []
  return {
    warnCalls,
    errorCalls,
    debug() {},
    info() {},
    warn(message, meta) { warnCalls.push({ message, meta }) },
    error(message, meta) { errorCalls.push({ message, meta }) },
  }
}

// The codex Responses 400 exactly like the live RUNX-01 capture, duck-typed onto an Error.
function makeApiCallError(): Error & { statusCode: number; responseBody: string } {
  return Object.assign(new Error('Bad Request'), {
    statusCode: 400,
    responseBody: '{"detail":"Unsupported parameter: max_output_tokens"}',
  })
}

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const screen: ScreenState = makeScreenState()

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepInstruction: 'Click sign in',
    testName: 'login test',
    previousSteps: [],
    plannerModel: {} as never,
    verifierModel: {} as never,
    ...overrides,
  }
}

const CLICK_ENVELOPE = {
  reasoning: 'Click the Sign In button to submit',
  confidence: 0.9,
  stepComplete: true,
  doesActionAdvanceUsTowardsGoal: true,
}

describe('LLMPlanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('projects a scripted tool call into a PlanResult with the v45 envelope intact', async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockResolvedValueOnce({
      toolCalls: [{ toolName: 'web_click', input: { ref: 'e1', ...CLICK_ENVELOPE } }],
      usage: { inputTokens: 100, outputTokens: 20 },
    } as never)

    const planner = new LLMPlanner({} as never, 'web', undefined, undefined, makeFakeTokenAccounting())
    const result = await planner.plan('Click sign in', screen, makeContext())

    expect(result.plan.action.type).toBe('click')
    expect(result.plan.action.ref).toBe('e1')
    expect(result.plan.reasoning).toBe(CLICK_ENVELOPE.reasoning)
    expect(result.plan.confidence).toBe(0.9)
    expect(result.plan.stepComplete).toBe(true)
    expect(result.tokenUsage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 })
  })

  it('retries once without the image when the screenshot send fails, annotating the prompt', async () => {
    const { generateText } = await import('ai')
    const mock = vi.mocked(generateText)
    mock.mockRejectedValueOnce(new Error('image payload too large'))
    mock.mockResolvedValueOnce({
      toolCalls: [{ toolName: 'web_click', input: { ref: 'e1', ...CLICK_ENVELOPE } }],
      usage: { inputTokens: 80, outputTokens: 10 },
    } as never)

    const planner = new LLMPlanner({} as never, 'web', undefined, undefined, makeFakeTokenAccounting())
    const result = await planner.plan('Click sign in', screen, makeContext({ screenshot: Buffer.from('png') }))

    expect(mock).toHaveBeenCalledTimes(2)
    // first call carried the image; the fallback turn retries with a text-only user
    // message carrying the note (the planning turn always drives via `messages`).
    const fallbackArgs = mock.mock.calls[1][0] as { messages?: { content?: unknown }[] }
    expect(JSON.stringify(fallbackArgs.messages)).toContain(
      '[Note: Visual screenshot is unavailable for this step. Rely on the accessibility tree for element identification.]',
    )
    expect(result.plan.action.type).toBe('click')
  })

  it('tolerates the `args` tool-call key variant as well as `input`', async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockResolvedValueOnce({
      toolCalls: [{ toolName: 'web_click', args: { ref: 'e2', ...CLICK_ENVELOPE } }],
      usage: { inputTokens: 50, outputTokens: 5 },
    } as never)

    const planner = new LLMPlanner({} as never, 'web', undefined, undefined, makeFakeTokenAccounting())
    const result = await planner.plan('Click sign in', screen, makeContext())

    expect(result.plan.action.type).toBe('click')
    expect(result.plan.action.ref).toBe('e2')
  })

  // 363-15 checkpoint fix (grounding regression): an ungroundable action must self-describe
  // in the logs — the diagnostic that revealed the "both ref+target" live regression. Element
  // handles only (ref/target), never a fill's text/value.
  it('logs a diagnostic warn (tool + which handles were supplied) when an action fails grounding', async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: 'web_click', input: { target: { role: 'button', name: 'Nonexistent' }, ...CLICK_ENVELOPE } }],
      usage: { inputTokens: 40, outputTokens: 8 },
    } as never)

    const logger = makeSpyLogger()
    const planner = new LLMPlanner({} as never, 'web', logger, undefined, makeFakeTokenAccounting())
    await planner.plan('Click a missing element', screen, makeContext()).catch(() => {})

    const diag = logger.warnCalls.find((c) => c.message === 'planner emitted an ungroundable action')
    expect(diag).toBeDefined()
    expect(diag?.meta?.tool).toBe('click')
    expect(diag?.meta?.hasRef).toBe(false)
    expect(diag?.meta?.hasTarget).toBe(true)
  })

  // Phase 355-01 (CTXB-04 / D-10) — RED until Plan 05 injects the TokenAccounting port
  // into LLMPlanner and feeds recordUsage(result.usage, messages) after each response.
  it('feeds the injected TokenAccounting recordUsage exactly once per response', async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockResolvedValueOnce({
      toolCalls: [{ toolName: 'web_click', input: { ref: 'e1', ...CLICK_ENVELOPE } }],
      usage: { inputTokens: 100, outputTokens: 20 },
    } as never)

    const accounting = makeFakeTokenAccounting()
    const planner = new LLMPlanner({} as never, 'web', undefined, undefined, accounting)
    await planner.plan('Click sign in', screen, makeContext())

    expect(accounting.recordUsageCalls).toHaveLength(1)
    expect(accounting.recordUsageCalls[0].messages.length).toBeGreaterThan(0)
  })

  // RUNX-04 (planner half): the swallowed provider-error catch must no longer collapse an
  // APICallError to a bare "Bad Request" — statusCode + responseBody must survive the runner
  // boundary so the codex 400 is diagnosable without a temporary patch.
  it('surfaces a provider APICallError statusCode + responseBody through the log meta and rethrown message', async () => {
    const { generateText } = await import('ai')
    const apiError = makeApiCallError()
    vi.mocked(generateText).mockRejectedValue(apiError as never)

    const logger = makeSpyLogger()
    const planner = new LLMPlanner({} as never, 'web', logger, undefined, makeFakeTokenAccounting())

    await expect(planner.plan('Click sign in', screen, makeContext())).rejects.toThrow(
      /Unsupported parameter: max_output_tokens/,
    )

    const logged = [...logger.warnCalls, ...logger.errorCalls]
    const providerLog = logged.find((call) => call.meta?.statusCode === 400)
    expect(providerLog).toBeDefined()
    expect(String(providerLog?.meta?.responseBody)).toContain('Unsupported parameter: max_output_tokens')
  })

  it('rethrows an ordinary Error unchanged (no provider fields) with no regression', async () => {
    const { generateText } = await import('ai')
    const plainError = new Error('boom (ordinary)')
    vi.mocked(generateText).mockRejectedValue(plainError as never)

    const logger = makeSpyLogger()
    const planner = new LLMPlanner({} as never, 'web', logger, undefined, makeFakeTokenAccounting())

    await expect(planner.plan('Click sign in', screen, makeContext())).rejects.toBe(plainError)
    // No provider enrichment fired for a plain error.
    const logged = [...logger.warnCalls, ...logger.errorCalls]
    expect(logged.some((call) => call.meta?.statusCode !== undefined)).toBe(false)
  })

  it('short-circuits an aborted signal via the existing abort path, rethrowing unchanged', async () => {
    const { generateText } = await import('ai')
    const abortError = makeApiCallError()
    vi.mocked(generateText).mockRejectedValue(abortError as never)

    const controller = new AbortController()
    controller.abort()

    const logger = makeSpyLogger()
    const planner = new LLMPlanner({} as never, 'web', logger, undefined, makeFakeTokenAccounting())

    await expect(
      planner.plan('Click sign in', screen, makeContext(), controller.signal),
    ).rejects.toBe(abortError)
    // The abort path rethrows before any provider enrichment/logging.
    expect(logger.warnCalls.some((call) => call.meta?.statusCode !== undefined)).toBe(false)
  })
})

describe('LLMPlanner cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a cancelled planning turn logs no screenshot retry and starts no second request', async () => {
    const { generateText } = await import('ai')
    const mock = vi.mocked(generateText)
    let markStarted!: () => void
    const callStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    mock.mockImplementation(((args: { abortSignal?: AbortSignal }) => {
      markStarted()
      return new Promise((_resolve, reject) => {
        const signal = args.abortSignal
        if (signal === undefined) return reject(new Error('the model call carried no abort signal'))
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }) as never)

    const logger = makeSpyLogger()
    const planner = new LLMPlanner({} as never, 'web', logger, undefined, makeFakeTokenAccounting())
    const controller = new AbortController()
    const turn = planner.plan(
      'Click sign in',
      screen,
      makeContext({ screenshot: Buffer.from('png') }),
      controller.signal,
    )
    await callStarted
    controller.abort()

    await expect(turn).rejects.toBe(controller.signal.reason)
    expect(logger.warnCalls.map((call) => call.message)).not.toContain(
      'Screenshot send failed, retrying without image',
    )
    expect(mock).toHaveBeenCalledTimes(1)
  })
})
