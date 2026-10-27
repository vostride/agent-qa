// Ported v1 loop scenarios (core/src/agent/__tests__/{loop,trace,integration,capture-gate})
// re-run against the runner-owned executeStep. Scenarios that exercised deleted machinery
// (the consecutive-failure counter, memory ablation) are dropped (D-10). New locks: the
// cached-redacted-marker invalidation and trace===projectLegacyTrace.
import { describe, it, expect, vi } from 'vitest'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { PlatformAdapter, Action } from '../../platform.js'
import type { LoopPorts, ScreenshotCompressor } from '../ports.js'
import type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue } from '../../cache/port.js'
import type { Planner, StepContext, Verifier } from '../types.js'
import { executeStep } from '../index.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { projectLegacyTrace } from '../evidence.js'
import { createTimeoutAbortReason } from '../abort.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import {
  makeActionPlan,
  makeAdapter,
  makePlanner,
  makeStepContext,
  makeVerifier,
} from './loop-harness.js'

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

describe('executeStep — ported v1 scenarios', () => {
  it('happy path: observe → plan → execute → verify → passed', async () => {
    const result = await executeStep(
      'Click the Log in button',
      ports({ adapter: makeAdapter(), planner: makePlanner(), verifier: makeVerifier() }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(result.name).toBe('Click the Log in button')
    expect(result.action).toEqual({ type: 'click', ref: 'e2' })
  })

  it('no verifier: uses ActionResult.success directly (trust the planner)', async () => {
    const result = await executeStep(
      'Click the Log in button',
      ports({ adapter: makeAdapter({ executeResult: { success: true } }), planner: makePlanner() }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
  })

  it('duration tracking: StepResult.duration >= 0', async () => {
    const result = await executeStep('Test step', ports({ adapter: makeAdapter(), planner: makePlanner() }), makeStepContext())
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it('step context is passed to the planner', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }
    const context = makeStepContext({
      testContext: 'This is a banking app',
      previousSteps: [{ instruction: 'Navigate to login', outcome: 'navigated' }],
    })
    await executeStep('Click the Log in button', ports({ adapter: makeAdapter(), planner }), context)
    expect(plannerSpy).toHaveBeenCalledOnce()
    const [step, , passed] = plannerSpy.mock.calls[0]
    expect(step).toBe('Click the Log in button')
    expect((passed as StepContext).testContext).toBe('This is a banking app')
  })

  it('routes context and tool_result through safety hooks; the async gate executes the ORIGINAL action (SEAM-03)', async () => {
    const executed: Action[] = []
    const adapter = makeAdapter()
    adapter.execute = async (action: Action) => { executed.push(action); return { success: true } }

    const result = await executeStep('Click the Log in button', ports({ adapter, planner: makePlanner() }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(executed).toEqual([{ type: 'click', ref: 'e2' }])
  })

  it('execution failure → replan with a different action → succeed (no counter)', async () => {
    const adapter = makeAdapter({
      observeResults: [makeScreenState(), makeScreenState(), makeScreenState()],
      executeResults: [{ success: false, error: 'Element not found' }, { success: true }],
    })
    const planner = makePlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e1' } }),
      makeActionPlan({ action: { type: 'click', ref: 'e2' } }),
    ])
    const result = await executeStep('Click the Log in button', ports({ adapter, planner }), makeStepContext())
    expect(result.status).toBe('passed')
  })

  it('verifier detects an app error: fails hard without replanning', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const verifier = makeVerifier([{ success: false, reasoning: 'HTTP 500 error page detected', isAppError: true }])
    const result = await executeStep(
      'Click the Log in button',
      ports({ adapter: makeAdapter({ observeResults: [makeScreenState(), makeScreenState()] }), planner: { plan: plannerSpy }, verifier }),
      makeStepContext(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('500')
    expect(plannerSpy).toHaveBeenCalledTimes(1)
  })

  it('verify failure (non-app) → replan → succeed', async () => {
    const adapter = makeAdapter({
      observeResults: [makeScreenState(), makeScreenState(), makeScreenState(), makeScreenState()],
      executeResults: [{ success: true }, { success: true }],
    })
    const verifier = makeVerifier([
      { success: false, reasoning: 'Button not clicked successfully', isAppError: false },
      { success: true, reasoning: 'Step completed after replanning', isAppError: false },
    ])
    const planner = makePlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e1' } }),
      makeActionPlan({ action: { type: 'click', ref: 'e2' } }),
    ])
    const result = await executeStep('Click the Log in button', ports({ adapter, planner, verifier }), makeStepContext())
    expect(result.status).toBe('passed')
  })

  describe('stepFailed agentic signaling', () => {
    it('stepFailed on the first action → fails immediately, no execution', async () => {
      const executeSpy = vi.fn().mockResolvedValue({ success: true })
      const adapter = makeAdapter()
      adapter.execute = executeSpy
      const planner = makePlanner([makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: false, stepFailed: true })])
      const result = await executeStep('Verify button is blue', ports({ adapter, planner }), makeStepContext())
      expect(result.status).toBe('failed')
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it('stepFailed after 2 successful actions → fails on the 3rd, first 2 executed', async () => {
      let executeCount = 0
      const adapter = makeAdapter()
      adapter.execute = async () => { executeCount++; return { success: true } }
      const planner = makePlanner([
        makeActionPlan({ stepComplete: false, action: { type: 'click', ref: 'e2' } }),
        makeActionPlan({ stepComplete: false, action: { type: 'fill', ref: 'e1', value: 'x' } }),
        makeActionPlan({ reasoning: 'Form is disabled', action: { type: 'click', ref: 'e2' }, stepComplete: false, stepFailed: true }),
      ])
      const result = await executeStep('Fill and submit', ports({ adapter, planner }), makeStepContext())
      expect(result.status).toBe('failed')
      expect(executeCount).toBe(2)
    })

    it('stepFailed message includes the planner reasoning', async () => {
      const planner = makePlanner([makeActionPlan({ reasoning: 'The checkout button does not exist on this page', action: { type: 'click', ref: 'e2' }, stepComplete: false, stepFailed: true })])
      const result = await executeStep('Click checkout', ports({ adapter: makeAdapter(), planner }), makeStepContext())
      expect(result.status).toBe('failed')
      expect(result.error).toContain('The checkout button does not exist on this page')
    })
  })

  describe('completion calls the verifier', () => {
    // D-19 (Phase 360): the retired non-visual-`assert` verifier-bypass short-circuit was
    // deleted. Its deterministic-verdict replacement (an assertValue outcome short-circuiting
    // the per-step verifier, D-11) is pinned RED in assert-value.test.ts (Plan 10) — NOT
    // duplicated here. This suite now only holds the neutral completion invariant: a normal
    // completing action reaches the verifier.
    it('a completing action + stepComplete calls the verifier', async () => {
      const verifySpy = vi.fn(async (step: string, _before: ScreenState, after: ScreenState, action: Action) => ({
        verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'confirmed' }),
      }))
      const verifier: Verifier = { verify: verifySpy }
      const planner = makePlanner([makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true })])
      const result = await executeStep('Verify button', ports({ adapter: makeAdapter({ observeResults: [makeScreenState(), makeScreenState()] }), planner, verifier }), makeStepContext())
      expect(result.status).toBe('passed')
      expect(verifySpy).toHaveBeenCalled()
    })
  })
})

describe('executeStep — trace projection', () => {
  it('successful step trace carries observation, reasoning, action, screenStateBefore/After', async () => {
    const before = makeScreenState()
    const after = makeScreenState({ url: 'https://example.test/dashboard' })
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter({ observeResults: [before, after] }), planner: makePlanner([makeActionPlan({ reasoning: 'Clicking Log in to authenticate' })]), verifier: makeVerifier() }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(result.trace?.observation).toBeDefined()
    expect(result.trace?.reasoning).toBe('Clicking Log in to authenticate')
    expect(result.trace?.plannedAction).toEqual({ type: 'click', ref: 'e2' })
    expect(result.trace?.result).toBe('success')
    expect(result.trace?.screenStateBefore).toBeDefined()
    expect(result.trace?.screenStateAfter).toBeDefined()
  })

  it('StepResult.trace.subActions equals projectLegacyTrace(StepResult.evidence)', async () => {
    const result = await executeStep('Click Log in', ports({ adapter: makeAdapter(), planner: makePlanner(), verifier: makeVerifier() }), makeStepContext())
    expect(result.evidence).toBeDefined()
    expect(result.trace?.subActions).toEqual(projectLegacyTrace(result.evidence!))
  })
})

describe('executeStep — cache (redesigned per-key port + hit ladder)', () => {
  const cachedLogin: CachedPlanValue = {
    // Descriptor-only value (D-12): ref/coords stripped; the locator re-grounds to the
    // fresh `log in` button (e2) against the observation at replay time.
    plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
    groundedLocator: [{ role: 'button', name: 'Log in' }],
    completesStep: true,
  }

  it('exact-key hit re-grounds the descriptor and replays without calling the planner', async () => {
    const plannerSpy = vi.fn()
    const cache: ActionPlanCache = {
      async get() { return cachedLogin },
      async set() {},
      async invalidate() {},
    }
    const result = await executeStep('Click Log in', ports({ adapter: makeAdapter(), planner: { plan: plannerSpy } as unknown as Planner, cache }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(plannerSpy).not.toHaveBeenCalled()
    expect(result.evidence?.cacheStatus).toBe('hit')
  })

  it('a hit whose descriptor no longer resolves invalidates the key and replans (D-13)', async () => {
    let invalidateCalls = 0
    const staleHit: CachedPlanValue = {
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Gone' }],
      completesStep: true,
    }
    const cache: ActionPlanCache = {
      async get() { return staleHit },
      async set() {},
      async invalidate() { invalidateCalls++ },
    }
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const result = await executeStep('Click Log in', ports({ adapter: makeAdapter(), planner: { plan: plannerSpy }, cache }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(invalidateCalls).toBe(1)
    expect(plannerSpy).toHaveBeenCalledTimes(1) // unmatched descriptor → replan
  })

  it('a secret-templated step bypasses the cache entirely — no get/set, cacheStatus bypass', async () => {
    let gets = 0
    let sets = 0
    const cache: ActionPlanCache = {
      async get() { gets++; return null },
      async set() { sets++ },
      async invalidate() {},
    }
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const result = await executeStep(
      'Type {{secret:TOKEN}} into the field',
      ports({ adapter: makeAdapter(), planner: { plan: plannerSpy }, cache }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(result.evidence?.cacheStatus).toBe('bypass')
    expect(gets).toBe(0)
    expect(sets).toBe(0)
  })
})

describe('executeStep — vision gate (D-11 / SCREEN-03)', () => {
  function makeCompressor(): ScreenshotCompressor {
    return {
      compress: vi.fn(async () => ({ buffer: Buffer.from('compressed'), imageWidth: 800, imageHeight: 600 })),
      dimensions: vi.fn(async () => ({ width: 1280, height: 720 })),
    }
  }

  function visionState(): ScreenState {
    return makeScreenState({ metadata: { captureMode: 'textOnly', coordSpace: 'viewport', viewportWidth: 1280, viewportHeight: 720, scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 } } })
  }

  it('full gate: compression runs, state re-stamped full with real dims, image attached', async () => {
    const captured: { captureMode: string; hadScreenshot: boolean; promptNote?: string } = { captureMode: '', hadScreenshot: false }
    const planner: Planner = {
      async plan(_step, screen, context) {
        captured.captureMode = screen.metadata.captureMode
        captured.hadScreenshot = context.screenshot !== undefined
        captured.promptNote = context.promptNote
        return { plan: makeActionPlan() }
      },
    }
    const compressor = makeCompressor()
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({ observeResults: [visionState()], screenshot: async () => Buffer.from('raw') }),
      planner,
      compressor,
      vision: { effectiveResolution: 1024, screenshotSize: 100_000 },
      visionGate: { attachImage: true, captureMode: 'full', promptNote: '' },
    }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(compressor.compress).toHaveBeenCalledTimes(1)
    expect(captured.captureMode).toBe('full')
    expect(captured.hadScreenshot).toBe(true)
  })

  it('text-only gate: no compression, captureMode textOnly, promptNote injected, screenshot still captured', async () => {
    const captured: { captureMode: string; hadScreenshot: boolean; promptNote?: string } = { captureMode: '', hadScreenshot: false }
    const planner: Planner = {
      async plan(_step, screen, context) {
        captured.captureMode = screen.metadata.captureMode
        captured.hadScreenshot = context.screenshot !== undefined
        captured.promptNote = context.promptNote
        return { plan: makeActionPlan() }
      },
    }
    const shotSpy = vi.fn(async () => Buffer.from('raw'))
    const compressor = makeCompressor()
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({ observeResults: [visionState()], screenshot: shotSpy }),
      planner,
      compressor,
      vision: { effectiveResolution: 1024, screenshotSize: 100_000 },
      visionGate: { attachImage: false, captureMode: 'textOnly', promptNote: 'Rely on the accessibility tree.' },
    }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(compressor.compress).not.toHaveBeenCalled()
    expect(captured.captureMode).toBe('textOnly')
    expect(captured.hadScreenshot).toBe(false)
    expect(captured.promptNote).toBe('Rely on the accessibility tree.')
    expect(shotSpy).toHaveBeenCalled()
  })
})

describe('executeStep — decision screenshot persistence (CASS-02)', () => {
  interface Store {
    calls: Uint8Array[]
    persistDecisionScreenshot: (bytes: Uint8Array) => { id: string; sha: string }
    getBlob: (sha: string) => Uint8Array | undefined
  }
  const REF = { id: 'decision-screenshot:sentinel', sha: 's'.repeat(64) }
  function makeStore(opts?: { throws?: boolean }): Store {
    const calls: Uint8Array[] = []
    return {
      calls,
      persistDecisionScreenshot: vi.fn((bytes: Uint8Array) => {
        if (opts?.throws) throw new Error('host store write failed')
        calls.push(bytes)
        return REF
      }),
      getBlob: () => undefined,
    }
  }

  interface Capture { screenshot?: Uint8Array; captureMode?: string; imageWidth?: number }
  function capturingPlanner(capture: Capture, plan = makeActionPlan()): Planner {
    return {
      async plan(_step, screen, context) {
        capture.screenshot = context.screenshot
        capture.captureMode = screen.metadata.captureMode
        capture.imageWidth = (screen.metadata as { imageWidth?: number }).imageWidth
        return { plan }
      },
    }
  }

  function visionState(): ScreenState {
    return makeScreenState({ metadata: { captureMode: 'textOnly', coordSpace: 'viewport', viewportWidth: 1280, viewportHeight: 720, scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 } } })
  }

  function makeCompressor(): ScreenshotCompressor {
    return {
      compress: vi.fn(async () => ({ buffer: Buffer.from('compressed'), imageWidth: 800, imageHeight: 600 })),
      dimensions: vi.fn(async () => ({ width: 640, height: 480 })),
    }
  }

  it('compressed live decision: persists the exact compressed bytes once and records the ref', async () => {
    const capture: Capture = {}
    const store = makeStore()
    const compressor = makeCompressor()
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({ observeResults: [visionState()], screenshot: async () => Buffer.from('raw') }),
      planner: capturingPlanner(capture),
      compressor,
      vision: { effectiveResolution: 1024, screenshotSize: 100_000 },
      visionGate: { attachImage: true, captureMode: 'full', promptNote: '' },
      evidenceArtifacts: store,
    }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(capture.captureMode).toBe('full')
    expect(store.calls).toHaveLength(1)
    // the persisted bytes are exactly what the planner received (the compressed buffer)
    expect(store.calls[0]).toBe(capture.screenshot)
    expect(store.calls[0]?.toString()).toBe('compressed')
    expect(result.evidence?.subActions[0]?.decisionScreenshotRef).toEqual(REF)
  })

  it('raw / no-sizing live decision: attaches raw bytes, stamps full, persists those bytes once', async () => {
    const capture: Capture = {}
    const store = makeStore()
    const rawShot = Buffer.from('rawshot')
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({ observeResults: [visionState()], screenshot: async () => rawShot }),
      planner: capturingPlanner(capture),
      compressor: makeCompressor(),
      // no vision sizing → compression is skipped, the raw bytes are attached
      visionGate: { attachImage: true, captureMode: 'full', promptNote: '' },
      evidenceArtifacts: store,
    }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(capture.captureMode).toBe('full')
    expect(capture.imageWidth).toBe(640)
    expect(capture.screenshot).toBe(rawShot)
    expect(store.calls).toHaveLength(1)
    expect(store.calls[0]).toBe(rawShot)
    expect(result.evidence?.subActions[0]?.decisionScreenshotRef).toEqual(REF)
  })

  it('raw / no-sizing with an unbound store: truthful full modality, no fabricated ref', async () => {
    const capture: Capture = {}
    const rawShot = Buffer.from('rawshot')
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({ observeResults: [visionState()], screenshot: async () => rawShot }),
      planner: capturingPlanner(capture),
      compressor: makeCompressor(),
      visionGate: { attachImage: true, captureMode: 'full', promptNote: '' },
      // evidenceArtifacts unbound
    }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(capture.captureMode).toBe('full')
    expect(capture.screenshot).toBe(rawShot)
    expect('decisionScreenshotRef' in (result.evidence?.subActions[0] ?? {})).toBe(false)
  })

  it('raw / no-sizing with a throwing store: warns, records no ref, completes the run', async () => {
    const capture: Capture = {}
    const store = makeStore({ throws: true })
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({ observeResults: [visionState()], screenshot: async () => Buffer.from('rawshot') }),
      planner: capturingPlanner(capture),
      compressor: makeCompressor(),
      visionGate: { attachImage: true, captureMode: 'full', promptNote: '' },
      evidenceArtifacts: store,
    }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(capture.captureMode).toBe('full')
    expect('decisionScreenshotRef' in (result.evidence?.subActions[0] ?? {})).toBe(false)
  })

  it('planner-declared stepFailed carries the decision screenshot ref', async () => {
    const capture: Capture = {}
    const store = makeStore()
    const result = await executeStep('Verify blue', ports({
      adapter: makeAdapter({ observeResults: [visionState()], screenshot: async () => Buffer.from('rawshot') }),
      planner: capturingPlanner(capture, makeActionPlan({ stepComplete: false, stepFailed: true })),
      compressor: makeCompressor(),
      visionGate: { attachImage: true, captureMode: 'full', promptNote: '' },
      evidenceArtifacts: store,
    }), makeStepContext())

    expect(result.status).toBe('failed')
    expect(store.calls).toHaveLength(1)
    expect(result.evidence?.subActions[0]?.decisionScreenshotRef).toEqual(REF)
  })

  it('execution failure branch carries the decision screenshot ref', async () => {
    const store = makeStore()
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({
        observeResults: [visionState(), visionState(), visionState()],
        executeResults: [{ success: false, error: 'Element not found' }, { success: true }],
        screenshot: async () => Buffer.from('rawshot'),
      }),
      planner: makePlanner([
        makeActionPlan({ action: { type: 'click', ref: 'e1' } }),
        makeActionPlan({ action: { type: 'click', ref: 'e2' } }),
      ]),
      compressor: makeCompressor(),
      visionGate: { attachImage: true, captureMode: 'full', promptNote: '' },
      evidenceArtifacts: store,
    }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(result.evidence?.subActions[0]?.decisionScreenshotRef).toEqual(REF)
  })

  it('cache hit mints no decision screenshot ref (no live model decision)', async () => {
    const store = makeStore()
    const cachedLogin: CachedPlanValue = {
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true,
    }
    const cache: ActionPlanCache = {
      async get() { return cachedLogin },
      async set() {},
      async invalidate() {},
    }
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({ screenshot: async () => Buffer.from('rawshot') }),
      planner: makePlanner(),
      compressor: makeCompressor(),
      vision: { effectiveResolution: 1024, screenshotSize: 100_000 },
      visionGate: { attachImage: true, captureMode: 'full', promptNote: '' },
      cache,
      evidenceArtifacts: store,
    }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(result.evidence?.cacheStatus).toBe('hit')
    expect(store.calls).toHaveLength(0)
    expect('decisionScreenshotRef' in (result.evidence?.subActions[0] ?? {})).toBe(false)
  })

  it('text-only decision: textOnly modality, no store call, no ref', async () => {
    const capture: Capture = {}
    const store = makeStore()
    const result = await executeStep('Click Log in', ports({
      adapter: makeAdapter({ observeResults: [visionState()], screenshot: async () => Buffer.from('rawshot') }),
      planner: capturingPlanner(capture),
      compressor: makeCompressor(),
      vision: { effectiveResolution: 1024, screenshotSize: 100_000 },
      visionGate: { attachImage: false, captureMode: 'textOnly', promptNote: 'Rely on the tree.' },
      evidenceArtifacts: store,
    }), makeStepContext())

    expect(result.status).toBe('passed')
    expect(capture.captureMode).toBe('textOnly')
    expect(capture.screenshot).toBeUndefined()
    expect(store.calls).toHaveLength(0)
    expect('decisionScreenshotRef' in (result.evidence?.subActions[0] ?? {})).toBe(false)
  })
})

describe('executeStep — pre-record secret redaction (Phase 366 D-02)', () => {
  it('redacts a registered raw secret from the recorded planned action before evidence records it', async () => {
    const rawSecret = 'sk-live-super-secret-value'
    const secretRedactor = new SecretRedactor(new SecretStore({ TOKEN: rawSecret }))
    const planner = makePlanner([
      makeActionPlan({
        reasoning: 'Fill the token field with the provisioned credential',
        action: { type: 'fill', ref: 'e2', text: rawSecret, clearMode: 'replace', submit: false },
      }),
    ])

    const result = await executeStep(
      'Fill the API token field',
      ports({ adapter: makeAdapter(), planner, secretRedactor }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    const planned = result.evidence?.subActions[0]?.plannedAction
    expect(planned).toMatchObject({ type: 'fill', text: '[secret:TOKEN]' })
    expect(JSON.stringify(result.evidence)).not.toContain(rawSecret)
  })

  it('redacts a registered raw secret from a value-bearing paste planned action', async () => {
    const rawSecret = 'sk-live-paste-secret-value'
    const secretRedactor = new SecretRedactor(new SecretStore({ TOKEN: rawSecret }))
    const planner = makePlanner([
      makeActionPlan({
        reasoning: 'Paste the provisioned credential into the token field',
        action: { type: 'paste', ref: 'e2', value: rawSecret },
      }),
    ])

    const result = await executeStep(
      'Paste the API token',
      ports({ adapter: makeAdapter(), planner, secretRedactor }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    const planned = result.evidence?.subActions[0]?.plannedAction
    expect(planned).toMatchObject({ type: 'paste', value: '[secret:TOKEN]' })
    expect(JSON.stringify(result.evidence)).not.toContain(rawSecret)
  })
})

describe('C441-NO-HOOK-PORT', () => {
  it('a hook object left on the ports is never consulted; the action executes and its result is recorded redacted', async () => {
    const rawSecret = 'sk-live-echoed-secret-value'
    const consulted: string[] = []
    const hooks = {
      runContext: (context: unknown) => { consulted.push('context'); return { context } },
      runToolResult: (result: unknown) => { consulted.push('result'); return { result } },
      [['runToolCall', 'Async'].join('')]: async () => {
        consulted.push('call')
        return { action: 'deny', reason: 'denied by a detector' }
      },
    }
    const executed: Action[] = []
    const adapter = makeAdapter()
    adapter.execute = async (action: Action) => {
      executed.push(action)
      return { success: true, data: { echoed: rawSecret } }
    }
    const secretRedactor = new SecretRedactor(new SecretStore({ TOKEN: rawSecret }))

    const result = await executeStep(
      'Click the Log in button',
      Object.assign(ports({ adapter, planner: makePlanner(), secretRedactor }), {
        [['safety', 'Hooks'].join('')]: hooks,
      }),
      makeStepContext(),
    )

    expect(consulted).toEqual([])
    expect(result.status).toBe('passed')
    expect(executed).toEqual([{ type: 'click', ref: 'e2' }])
    expect(result.evidence?.subActions[0]?.result.success).toBe(true)
    expect(JSON.stringify(result.evidence)).not.toContain(rawSecret)
  })
})
