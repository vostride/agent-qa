// runMemberTest contract, pinned against fakes (Phase 363 D-05, RESEARCH Q2). Fully
// faked: fake adapter, a stubbed executeStep loop seam, fake HookExecutorPort, a fake
// MemberEventSink (all Plan 03 legs), a stub extractor factory, and injected fake
// handlers for runJS / appium / a11y / failure-shot. No real fs, providers, or LLM.
// Runner convention: `.js`-suffixed relative specifiers.
import { describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import type { PlatformAdapter } from '../../platform.js'
import type { StepResult } from '../../result.js'
import type { EvidenceArtifactStorePort, LoopPorts } from '../../loop/ports.js'
import type { StepContext, VariableExtractor } from '../../loop/types.js'
import type { HookExecutorPort } from '../ports.js'
import type { HookDefinition } from '../../hooks/types.js'
import { runMemberTest } from '../member-runner.js'
import type { MemberRunConfig, MemberTest } from '../member-runner.js'

const fakeModel = {} as unknown as LanguageModel
const VALID_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

// ---- fakes ----------------------------------------------------------------

interface SinkCapture {
  sink: MemberRunConfig['sink']
  stepStarted: { stepIndex: number; stepText: string }[]
  hookStarted: unknown[]
  hookFinished: { kind?: string; status: string; hookName: string }[]
  testRetryScheduled: { attempt: number; maxAttempts: number; reason?: string }[]
  stepFinalized: number
}

function makeSink(): SinkCapture {
  const capture: SinkCapture = {
    stepStarted: [],
    hookStarted: [],
    hookFinished: [],
    testRetryScheduled: [],
    stepFinalized: 0,
    sink: undefined as unknown as MemberRunConfig['sink'],
  }
  capture.sink = {
    stepStarted(input) {
      capture.stepStarted.push(input)
    },
    loopEmitFor() {
      return {
        stepFinalized() {
          capture.stepFinalized++
        },
        subActionRecorded() {},
      }
    },
    hookStarted(input) {
      capture.hookStarted.push(input)
    },
    hookFinished(input) {
      capture.hookFinished.push({ kind: input.kind, status: input.status, hookName: input.hookName })
    },
    testRetryScheduled(input) {
      capture.testRetryScheduled.push({ attempt: input.attempt, maxAttempts: input.maxAttempts, reason: input.reason })
    },
  }
  return capture
}

function makeAdapter(overrides: Partial<PlatformAdapter> & Record<string, unknown> = {}): PlatformAdapter {
  const adapter = {
    platform: 'web' as const,
    async setup() {},
    async cleanup() {},
    async observe() {
      return makeScreenState()
    },
    async execute() {
      return { success: true }
    },
    ...overrides,
  }
  return adapter as unknown as PlatformAdapter
}

/** A step result stub with the minimum fields the member-runner threads. */
function stepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    name: 'step',
    status: 'passed',
    duration: 1,
    trace: {
      observation: '',
      reasoning: 'did the thing',
      plannedAction: { type: 'click', ref: 'e1' } as never,
      result: 'success',
      screenStateBefore: '',
    },
    ...overrides,
  }
}

interface Recorder {
  fn: (i: string, p: LoopPorts, c: StepContext) => Promise<StepResult>
  instructions: string[]
  contexts: StepContext[]
}

/** A stubbed executeStep loop seam recording the instruction + context per call. */
function recordingExecuteStep(results: StepResult[] | ((call: number) => StepResult)): Recorder {
  const rec: Recorder = { instructions: [], contexts: [], fn: undefined as never }
  let call = 0
  rec.fn = async (instruction, ports, context) => {
    rec.instructions.push(instruction)
    rec.contexts.push(context)
    // Simulate the loop's single terminal stepFinalized emission.
    ports.events?.stepFinalized({} as never, { status: 'passed', durationMs: 1 })
    const idx = call++
    const r = typeof results === 'function' ? results(idx) : results[Math.min(idx, results.length - 1)]
    return { ...r }
  }
  return rec
}

function baseConfig(overrides: Partial<MemberRunConfig> = {}): MemberRunConfig {
  const sink = makeSink()
  return {
    adapter: makeAdapter(),
    planner: { async plan() { return { plan: { reasoning: '', action: { type: 'click' }, confidence: 1, stepComplete: true } } } },
    plannerModel: fakeModel,
    verifierModel: fakeModel,
    sink: sink.sink,
    testIndex: 0,
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

function member(overrides: Partial<MemberTest> = {}): MemberTest {
  return {
    testId: 't_member',
    name: 'Member test',
    filePath: '/tests/member.yaml',
    steps: ['Click OK'],
    ...overrides,
  }
}

// ---- pipeline ordering ----------------------------------------------------

describe('runMemberTest — inline-DSL pipeline order', () => {
  it('runs inline hooks BEFORE interpolation (the same step consumes a hook-set var)', async () => {
    const sink = makeSink()
    const rec = recordingExecuteStep([stepResult()])
    const hookExecutor: HookExecutorPort = {
      async execute() {
        return { success: true, variables: { TOKEN: 'RESOLVED' }, output: '', stdout: 'ok', stderr: '', duration: 2 }
      },
    }
    const hookDef: HookDefinition = { id: VALID_HOOK_ID, name: 'seed', runtime: 'node', file: 'seed.js', deps: [], timeout: 1000, network: false }
    const result = await runMemberTest(
      member({ steps: [`Use {{runHook:"${VALID_HOOK_ID}"}} then {{env:TOKEN}}`] }),
      baseConfig({
        sink: sink.sink,
        executeStep: rec.fn,
        hookExecutor,
        inlineHookDefs: new Map([[VALID_HOOK_ID, hookDef]]),
      }),
    )
    expect(result.status).toBe('passed')
    // Hook ran + stripped, THEN interpolation resolved {{env:TOKEN}} from the hook output.
    expect(rec.instructions[0]).toBe('Use then RESOLVED')
    expect(rec.instructions[0]).not.toContain('{{')
    expect(sink.hookStarted).toHaveLength(1)
    expect(sink.hookFinished).toEqual([{ kind: 'hook', status: 'passed', hookName: 'seed' }])
  })

  it('resolves runJS BEFORE the unresolved-template check (step is not failed as unresolved)', async () => {
    const rec = recordingExecuteStep([stepResult()])
    const runJs = vi.fn(async () => ({ value: 'Example' }))
    const result = await runMemberTest(
      member({ steps: ['Title is {{runJS:"document.title"}}'] }),
      baseConfig({ executeStep: rec.fn, runJs }),
    )
    expect(result.status).toBe('passed')
    expect(runJs).toHaveBeenCalledWith('document.title', expect.anything())
    // Had the unresolved check run before runJS, the {{runJS}} token would have failed the step.
    expect(rec.instructions[0]).toBe('Title is Example')
    expect(rec.instructions).toHaveLength(1)
  })

  it('passes each step its position in the member', async () => {
    const rec = recordingExecuteStep([stepResult()])
    const result = await runMemberTest(
      member({ steps: ['Type the message', 'Send the message'] }),
      baseConfig({ executeStep: rec.fn }),
    )
    expect(result.status).toBe('passed')
    expect(rec.contexts.map(c => [c.stepNumber, c.stepCount])).toEqual([[1, 2], [2, 2]])
  })

  it('fails a step with an unresolved {{env:X}} after runJS resolution', async () => {
    const rec = recordingExecuteStep([stepResult()])
    const result = await runMemberTest(
      member({ steps: ['Go to {{env:MISSING}}'] }),
      baseConfig({ executeStep: rec.fn }),
    )
    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('Unresolved template variable')
    // executeStep never ran — the check gated it.
    expect(rec.instructions).toHaveLength(0)
  })
})

// ---- retry semantics ------------------------------------------------------

describe('runMemberTest — retry loop', () => {
  it('fails twice then passes: two testRetryScheduled, ONE final result, retryCount=2', async () => {
    const sink = makeSink()
    const rec = recordingExecuteStep((call) =>
      call < 2 ? stepResult({ status: 'failed', error: 'boom' }) : stepResult({ status: 'passed' }),
    )
    const result = await runMemberTest(
      member({ steps: ['Click OK'], meta: { retries: 2 } }),
      baseConfig({ sink: sink.sink, executeStep: rec.fn }),
    )
    expect(result.status).toBe('passed')
    expect(result.retryCount).toBe(2)
    expect(sink.testRetryScheduled.map(r => r.attempt)).toEqual([1, 2])
    expect(sink.testRetryScheduled[0].maxAttempts).toBe(3)
    expect(sink.testRetryScheduled[1].reason).toContain('boom')
    // Three attempts ran the single step once each.
    expect(rec.instructions).toHaveLength(3)
  })

  it('exhausts retries and returns the final failed result with retryCount=maxRetries', async () => {
    const sink = makeSink()
    const rec = recordingExecuteStep([stepResult({ status: 'failed', error: 'nope' })])
    const result = await runMemberTest(
      member({ steps: ['Click OK'], meta: { retries: 1 } }),
      baseConfig({ sink: sink.sink, executeStep: rec.fn }),
    )
    expect(result.status).toBe('failed')
    expect(result.retryCount).toBe(1)
    expect(sink.testRetryScheduled.map(r => r.attempt)).toEqual([1])
  })
})

// ---- timeout / abort ------------------------------------------------------

describe('runMemberTest — timeout & cancellation', () => {
  it('tags a failed result when the per-test deadline elapses', async () => {
    const rec = recordingExecuteStep([stepResult()])
    const slowFirst: typeof rec.fn = async (instruction, ports, context) => {
      rec.instructions.push(instruction)
      rec.contexts.push(context)
      if (rec.instructions.length === 1) await new Promise(r => setTimeout(r, 40))
      return stepResult()
    }
    const result = await runMemberTest(
      member({ steps: ['first', 'second'], meta: { timeout: 5 } }),
      baseConfig({ executeStep: slowFirst }),
    )
    expect(result.status).toBe('failed')
    expect(result.steps.some(s => (s.error ?? '').includes('timed out'))).toBe(true)
    expect(result.failureSummary ?? '').toContain('timed out')
  })

  it('returns a cancelled result when the external abort signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort(new Error('The run was cancelled before this test finished.'))
    const rec = recordingExecuteStep([stepResult()])
    const result = await runMemberTest(
      member({ steps: ['Click OK'] }),
      baseConfig({ executeStep: rec.fn, abortSignal: ac.signal }),
    )
    expect(result.status).toBe('cancelled')
    expect(result.steps).toHaveLength(0)
    expect(result.failureSummary).toContain('cancelled')
    expect(rec.instructions).toHaveLength(0)
  })
})

// ---- capture / device logs / previousSteps / snapshot / failure summary ---

describe('runMemberTest — per-test responsibilities', () => {
  it('writes a captured variable to the store via the injected extractor + model', async () => {
    const rec = recordingExecuteStep([stepResult({ status: 'passed' })])
    const extractSpy = vi.fn<VariableExtractor['extract']>(async () => ({
      success: true,
      variableName: 'CODE',
      value: 'ABC123',
      reasoning: 'ok',
    }))
    const extractorFactory = vi.fn(() => ({ extract: extractSpy }) as VariableExtractor)
    const result = await runMemberTest(
      member({ steps: [{ step: 'Read the code', capture: { variable: 'CODE', method: 'ai' } }] }),
      baseConfig({ executeStep: rec.fn, extractorFactory }),
    )
    expect(result.status).toBe('passed')
    expect(extractorFactory).toHaveBeenCalledWith(fakeModel, 'ai')
    expect(result.steps[0].capturedVariables).toEqual({ CODE: 'ABC123' })
    expect(result.steps[0].variableSnapshot?.CODE).toEqual({ value: 'ABC123', source: 'capture' })
  })

  it('captures via the pure regex extractor without a model (createExtractor default)', async () => {
    const rec = recordingExecuteStep([stepResult({ status: 'passed' })])
    const result = await runMemberTest(
      member({ steps: [{ step: 'Read', capture: { variable: 'CODE', method: 'regex', pattern: 'code: (\\w+)' } }] }),
      baseConfig({
        executeStep: rec.fn,
        adapter: makeAdapter({ async observe() { return makeScreenState({ tree: 'code: ZZ99' }) } }),
      }),
    )
    expect(result.steps[0].capturedVariables).toEqual({ CODE: 'ZZ99' })
  })

  it('drains device logs and threads previousSteps into later step context', async () => {
    const pollDeviceLogs = vi.fn(async () => {})
    const drainConsoleLogs = vi.fn(() => [{ level: 'log', text: 'hi', timestamp: 1 }])
    const drainNetworkLogs = vi.fn(() => [])
    const rec = recordingExecuteStep([stepResult(), stepResult()])
    const result = await runMemberTest(
      member({ steps: ['first step', 'second step'] }),
      baseConfig({
        executeStep: rec.fn,
        adapter: makeAdapter({ pollDeviceLogs, drainConsoleLogs, drainNetworkLogs }),
      }),
    )
    expect(result.status).toBe('passed')
    expect(pollDeviceLogs).toHaveBeenCalledTimes(2)
    expect(result.steps[0].consoleLogs).toHaveLength(1)
    // Second step's context sees the first step in previousSteps.
    expect(rec.contexts[1].previousSteps).toHaveLength(1)
    expect(rec.contexts[1].previousSteps[0].instruction).toBe('first step')
  })

  it('redacts the variable snapshot at step end via the injected redactor', async () => {
    const rec = recordingExecuteStep([stepResult({ status: 'passed' })])
    const secretRedactor = { redactString: (v: string) => v.replaceAll('SEEKRIT', '[redacted]') }
    const result = await runMemberTest(
      member({ steps: ['Click OK'] }),
      baseConfig({ executeStep: rec.fn, cliVars: { PASS: 'SEEKRIT' }, secretRedactor }),
    )
    expect(result.steps[0].variableSnapshot?.PASS.value).toBe('[redacted]')
  })

  it('assembles a failure summary on failure and emits stepStarted per step', async () => {
    const sink = makeSink()
    const rec = recordingExecuteStep([stepResult({ name: 'Click OK', status: 'failed', error: 'element not found' })])
    const result = await runMemberTest(
      member({ steps: ['Click OK'] }),
      baseConfig({ sink: sink.sink, executeStep: rec.fn }),
    )
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('failed: element not found')
    expect(sink.stepStarted).toEqual([{ stepIndex: 0, stepText: 'Click OK' }])
    expect(sink.stepFinalized).toBe(1)
  })

  it('threads the run-scoped evidenceArtifacts store into every step LoopPorts by identity', async () => {
    const store: EvidenceArtifactStorePort = {
      persistDecisionScreenshot: () => ({ id: 'decision-screenshot:x', sha: 'a'.repeat(64) }),
      getBlob: () => undefined,
    }
    const captured: LoopPorts[] = []
    const capturing: (i: string, p: LoopPorts, c: StepContext) => Promise<StepResult> = async (_i, p) => {
      captured.push(p)
      p.events?.stepFinalized({} as never, { status: 'passed', durationMs: 1 })
      return stepResult()
    }
    const result = await runMemberTest(
      member({ steps: ['first', 'second'] }),
      baseConfig({ executeStep: capturing, evidenceArtifacts: store }),
    )
    expect(result.status).toBe('passed')
    expect(captured).toHaveLength(2)
    expect(captured[0].evidenceArtifacts).toBe(store)
    expect(captured[1].evidenceArtifacts).toBe(store)
  })

  it('passes undefined evidenceArtifacts when no store is bound', async () => {
    const captured: LoopPorts[] = []
    const capturing: (i: string, p: LoopPorts, c: StepContext) => Promise<StepResult> = async (_i, p) => {
      captured.push(p)
      p.events?.stepFinalized({} as never, { status: 'passed', durationMs: 1 })
      return stepResult()
    }
    await runMemberTest(
      member({ steps: ['only'] }),
      baseConfig({ executeStep: capturing }),
    )
    expect(captured[0].evidenceArtifacts).toBeUndefined()
  })

  it('threads the live knowledge reader, budgets, ordinal, ledger, and turn reset into LoopPorts', async () => {
    const reader = { getRunBrief: vi.fn() } as never
    const budgets = {
      brief: 512,
      searchResults: 512,
      caution: 96,
      readBody: 1_024,
      recordCap: 12,
    }
    const ledger = {
      admit: vi.fn(),
      resetTurn: vi.fn(),
      size: vi.fn(),
    } as never
    const beginMemoryTurn = vi.fn()
    const drainMemoryReadTraces = vi.fn(() => [])
    const captured: LoopPorts[] = []
    const capturing: (i: string, p: LoopPorts, c: StepContext) => Promise<StepResult> = async (_i, p) => {
      captured.push(p)
      p.events?.stepFinalized({} as never, { status: 'passed', durationMs: 1 })
      return stepResult()
    }

    await runMemberTest(
      member({ steps: ['only'] }),
      baseConfig({
        executeStep: capturing,
        knowledgeReader: reader,
        knowledgeBudgets: budgets,
        knowledgeAsOfBuild: 41,
        recordLedger: ledger,
        beginMemoryTurn,
        drainMemoryReadTraces,
      }),
    )

    expect(captured[0].knowledgeReader).toBe(reader)
    expect(captured[0].knowledgeBudgets).toBe(budgets)
    expect(captured[0].knowledgeAsOfBuild).toBe(41)
    expect(captured[0].recordLedger).toBe(ledger)
    expect(captured[0].beginMemoryTurn).toBe(beginMemoryTurn)
    expect(captured[0].drainMemoryReadTraces).toBe(drainMemoryReadTraces)
  })

  it('runs an inline appium directive through the injected appiumScript handler', async () => {
    const rec = recordingExecuteStep([stepResult()])
    const appiumScript = vi.fn(async () => ({ success: true, data: { ok: 1 } }))
    const result = await runMemberTest(
      member({ steps: ['{{appium: mobile: scroll, direction: down}}'] }),
      baseConfig({ executeStep: rec.fn, appiumScript, adapter: makeAdapter({ platform: 'android' }) }),
    )
    expect(result.status).toBe('passed')
    expect(appiumScript).toHaveBeenCalledTimes(1)
    // executeStep bypassed for the inline appium path.
    expect(rec.instructions).toHaveLength(0)
    expect(result.steps[0].observation).toContain('Script returned')
  })
})
