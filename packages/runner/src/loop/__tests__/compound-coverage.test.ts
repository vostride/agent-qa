// EXEC-01..04 requirement roll-call (Phase 359, Plan 09 close-out).
// Each acceptance criterion maps to at least one assertion here over the shipped runner compound
// surface: the pure comparators and loops
// (../../compound/{fill-verify,scroll-until-visible,app-resolution,idempotency}), the dispatch
// seam short-circuit (../index executeStep) and the frozen tool catalog (../../tools). The
// compound/__tests__ suites, loop/__tests__/idempotency and packages/{web,android,ios}
// compound.test.ts own the exhaustive matrices.
import { describe, it, expect } from 'vitest'

import type { ScreenState } from '@vostride/agent-qa-schema'

import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import type { LoopPorts } from '../ports.js'

import { compareFillReread } from '../../compound/fill-verify.js'
import {
  runUntilVisibleLoop,
  type ScrollPrimitives,
  type SwipeSignal,
  type Direction,
} from '../../compound/scroll-until-visible.js'
import type { InterimNode } from '../../screen-builder.js'
import { resolveAppName } from '../../compound/app-resolution.js'
import { executeStep } from '../index.js'
import { buildAgentScreenState } from './screen-fixtures.js'
import { makeActionPlan, makeStepContext, makeVerifier, makePlanner } from './loop-harness.js'
import { ToolRegistry } from '../../tools/registry.js'
import { registerAllActions } from '../../tools/actions/index.js'

function node(name: string, opts: Partial<InterimNode> = {}): InterimNode {
  return { role: 'text', name, ...opts }
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

// -----------------------------------------------------------------------------
// EXEC-01 — atomic Fill with a verified re-read (clear→type→re-read→(Enter))
// -----------------------------------------------------------------------------
describe('EXEC-01 — Fill executes as one atomic compound producing a single ActionResult with a verified field re-read', () => {
  it('a genuine value-loss mismatch is an honest failure verdict with the byte-pinned fillReread shape and a §7.1 self-correcting error', () => {
    const miss = compareFillReread({ expected: 'hello', actual: 'helo', secure: false })
    expect(miss.ok).toBe(false)
    expect(miss.verdict).toBe('mismatch')
    // metadata.fillReread = { expected, actual }, both strings, never nested.
    expect(miss.meta).toEqual({ expected: 'hello', actual: 'helo' })
    expect(Object.keys(miss.meta ?? {}).sort()).toEqual(['actual', 'expected'])
    expect(miss.selfCorrectingError).toContain('re-observe and retry')
  })

  it('a card number the field re-groups with spaces is normalized, not a loss (437 D-06)', () => {
    const formatted = compareFillReread({ expected: '4242424242424242', actual: '4242 4242 4242 4242', secure: false })
    expect(formatted.ok).toBe(true)
    expect(formatted.verdict).toBe('normalized')
    expect(formatted.meta).toEqual({ expected: '4242424242424242', actual: '4242 4242 4242 4242' })
    expect(formatted.selfCorrectingError).toBeUndefined()
  })

  it('secure fields are never exact: non-empty is unverified, and the raw value is never echoed (T-359-02 masking)', () => {
    const secure = compareFillReread({ expected: 'topSecretPw', actual: 'topSecretPw', secure: true })
    expect(secure.ok).toBe(true)
    expect(secure.verdict).toBe('unverified')
    expect(secure.secure).toBe(true)
    expect(secure.meta?.expected).not.toContain('topSecret')
    expect(secure.meta?.actual).not.toContain('topSecret')
    // An empty secure re-read (nothing landed) still fails honestly.
    expect(compareFillReread({ expected: 'topSecretPw', actual: '', secure: true }).ok).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// EXEC-02 — scroll-until-visible: executor-owned loop over operation-specific signals (D-24/D-25)
// -----------------------------------------------------------------------------
function scrollPrimitives(
  trees: () => InterimNode[],
  signal: () => SwipeSignal = () => 'unknown',
  swipeLog?: Direction[],
): ScrollPrimitives {
  return {
    async swipeOnce(direction: Direction) {
      swipeLog?.push(direction)
      return signal()
    },
    async readInterimTree() {
      return trees()
    },
  }
}

describe('EXEC-02 — untilVisible re-observes between ≤maxSwipes swipes and terminates on target-visible / max-swipes / boundary', () => {
  it('terminates found the moment the target appears in the re-read tree', async () => {
    let call = 0
    const prims = scrollPrimitives(() => {
      call += 1
      return call === 1 ? [node('Row A'), node('Row B')] : [node('Row A'), node('Settings')]
    })
    const r = await runUntilVisibleLoop(prims, { target: 'Settings', direction: 'down', maxSwipes: 5, retryOpposite: false })
    expect(r.found).toBe(true)
    expect(r.meta).toEqual({ swipes: 1, reversedOnce: false, outcome: 'found', endedBy: 'target-visible' })
  })

  it('an unchanging tree while the container moves is not an end: the search uses its whole budget and stays unresolved', async () => {
    const SAME = [node('Row A'), node('Row B')]
    const r = await runUntilVisibleLoop(scrollPrimitives(() => SAME, () => 'moved'), {
      target: 'Nope',
      direction: 'down',
      maxSwipes: 3,
      retryOpposite: false,
    })
    expect(r.found).toBe(false)
    expect(r.meta).toEqual({ swipes: 3, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes' })
  })

  it('a changing tree without a movement signal is not progress either: same budget, same unresolved outcome', async () => {
    let n = 0
    const r = await runUntilVisibleLoop(scrollPrimitives(() => { n += 1; return [node(`Row ${n}`)] }), {
      target: 'Nope',
      direction: 'down',
      maxSwipes: 3,
      retryOpposite: false,
    })
    expect(r.found).toBe(false)
    expect(r.meta).toEqual({ swipes: 3, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes' })
  })

  it('retryOpposite reverses only after the budget or a boundary, exactly once, and both boundaries end not-found', async () => {
    const SAME = [node('Row A')]
    const dirs: Direction[] = []
    const stalled = await runUntilVisibleLoop(scrollPrimitives(() => SAME, () => 'unknown', dirs), {
      target: 'Nope',
      direction: 'down',
      maxSwipes: 2,
      retryOpposite: true,
    })
    expect(dirs).toEqual(['down', 'down', 'up', 'up'])
    expect(stalled.meta).toEqual({ swipes: 4, reversedOnce: true, outcome: 'unresolved', endedBy: 'max-swipes' })

    const bounded: Direction[] = []
    const walls = await runUntilVisibleLoop(scrollPrimitives(() => SAME, () => 'at-boundary', bounded), {
      target: 'Nope',
      direction: 'down',
      maxSwipes: 4,
      retryOpposite: true,
    })
    expect(bounded).toEqual(['down', 'up'])
    expect(walls.meta).toEqual({ swipes: 2, reversedOnce: true, outcome: 'not-found', endedBy: 'boundary' })
  })
})

// -----------------------------------------------------------------------------
// EXEC-03 — openApp name→bundle resolution: never a silent wrong-app launch
// -----------------------------------------------------------------------------
describe('EXEC-03 — resolveAppName climbs exact → fuzzy(+margin) → ambiguous/unknown, never a coin-flip launch', () => {
  const REGISTRY = [
    { id: 'com.google.android.calendar' },
    { id: 'com.spotify.music' },
    { id: 'com.android.chrome' },
  ]

  it('an id segment resolves exact', () => {
    const r = resolveAppName('calendar', REGISTRY)
    expect(r).toEqual({ kind: 'exact', id: 'com.google.android.calendar' })
  })

  it('a clear misspelling that leads the field by the margin resolves fuzzy to a single id', () => {
    const r = resolveAppName('calender', REGISTRY)
    expect(r.kind).toBe('fuzzy')
    expect(r).toMatchObject({ id: 'com.google.android.calendar' })
  })

  it('a near-tie yields ambiguous candidates, NOT a winner (never a coin-flip)', () => {
    const r = resolveAppName('mial', [{ id: 'com.foo.mail' }, { id: 'com.bar.mail' }])
    expect(r.kind).toBe('ambiguous')
    expect(r).not.toHaveProperty('id')
    if (r.kind === 'ambiguous') expect(r.candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('an unknown name yields structured unknown candidates, never a silent launch', () => {
    const r = resolveAppName('zzzzzzzz', REGISTRY)
    expect(r.kind).toBe('unknown')
    expect(r).not.toHaveProperty('id')
    if (r.kind === 'unknown') expect(Array.isArray(r.candidates)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// EXEC-04 — toggle/picker idempotency at the dispatch seam
// -----------------------------------------------------------------------------
function recordingAdapter(observation: ScreenState, calls: Action[]): PlatformAdapter {
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return observation
    },
    async execute(action: Action): Promise<ActionResult> {
      calls.push(action)
      return { success: true }
    },
  }
}

interface LooseSub {
  result?: { success?: boolean; error?: string; metadata?: Record<string, unknown> }
}

describe('EXEC-04 — a satisfied desiredState no-ops at the dispatch seam without calling adapter.execute', () => {
  it('a checked toggle with desiredState=checked mints a no-input no-op (437 D-05)', async () => {
    const observation = buildAgentScreenState({
      url: 'https://x.test/settings',
      elements: [{ ref: 'e1', role: 'checkbox', name: 'Wi-Fi', state: { checked: true }, bounds: { x: 20, y: 80, width: 300, height: 44 } }],
      metadata: { coordSpace: 'viewport', viewportWidth: 390, viewportHeight: 844 },
    })
    const calls: Action[] = []
    const adapter = recordingAdapter(observation, calls)
    const plans = [makeActionPlan({ action: { type: 'tap', ref: 'e1', desiredState: 'checked' }, stepComplete: true })]

    const result = await executeStep(
      'Ensure Wi-Fi is on',
      ports({ adapter, planner: makePlanner(plans), verifier: makeVerifier(), plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 } }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    // D-14: the check runs at the ONE chokepoint before adapter.execute ⇒ zero adapter calls.
    expect(calls.length).toBe(0)
    // D-16: the minted no-op carries metadata.idempotentNoop.currentState ...
    const sub = (result.evidence as { subActions?: LooseSub[] } | undefined)?.subActions?.[0]
    const noop = sub?.result?.metadata?.['idempotentNoop'] as { currentState?: unknown } | undefined
    expect(noop).toEqual({ currentState: 'checked', inputSent: false })
    expect(sub?.result?.success).toBe(false)
    expect(sub?.result?.error).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// 437 D-06: a fill counts as one compound input whether its read-back was readable or unverified
// -----------------------------------------------------------------------------
function scriptedAdapter(observation: ScreenState, result: ActionResult): PlatformAdapter {
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return observation
    },
    async execute(): Promise<ActionResult> {
      return result
    },
  }
}

describe('437 D-06 — an unverified fill still counts as one compound input', () => {
  const observation = buildAgentScreenState({
    url: 'https://x.test/form',
    elements: [{ ref: 'e1', role: 'textbox', name: 'Name', bounds: { x: 20, y: 80, width: 300, height: 44 } }],
    metadata: { coordSpace: 'viewport', viewportWidth: 390, viewportHeight: 844 },
  })

  async function runOne(action: { type: string; [key: string]: unknown }, result: ActionResult) {
    return executeStep(
      'Fill the name',
      ports({
        adapter: scriptedAdapter(observation, result),
        planner: makePlanner([makeActionPlan({ action, stepComplete: true })]),
        verifier: makeVerifier(),
        plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 },
      }),
      makeStepContext(),
    )
  }

  it('a result carrying only fillVerdict unverified counts one fill input', async () => {
    const result = await runOne(
      { type: 'fill', ref: 'e1', text: 'Ada', clearMode: 'replace', submit: false },
      { success: true, metadata: { fillVerdict: { verb: 'fill', verdict: 'unverified' } } },
    )
    expect(result.evidence?.limitUsage?.compoundInputs).toEqual([{ subActionIndex: 0, kind: 'fill', count: 1 }])
  })

  it('a result carrying fillReread and fillVerdict counts once, not twice', async () => {
    const result = await runOne(
      { type: 'fill', ref: 'e1', text: 'Ada', clearMode: 'replace', submit: false },
      {
        success: true,
        metadata: { fillReread: { expected: 'Ada', actual: 'Ada' }, fillVerdict: { verb: 'fill', verdict: 'exact' } },
      },
    )
    expect(result.evidence?.limitUsage?.compoundInputs).toEqual([{ subActionIndex: 0, kind: 'fill', count: 1 }])
  })

  it('a clearText verdict counts no fill input', async () => {
    const result = await runOne(
      { type: 'clearText', ref: 'e1' },
      { success: true, metadata: { fillVerdict: { verb: 'clearText', verdict: 'exact' } } },
    )
    expect(result.evidence?.limitUsage?.compoundInputs).toBeUndefined()
  })

  it('a clearText verdict beside a fillReread block still counts no fill input', async () => {
    const result = await runOne(
      { type: 'clearText', ref: 'e1' },
      {
        success: true,
        metadata: { fillReread: { expected: '', actual: '' }, fillVerdict: { verb: 'clearText', verdict: 'exact' } },
      },
    )
    expect(result.evidence?.limitUsage?.compoundInputs).toBeUndefined()
  })

  it('a pre-437 result with fillReread alone still counts one fill input', async () => {
    const result = await runOne(
      { type: 'fill', ref: 'e1', text: 'Ada', clearMode: 'replace', submit: false },
      { success: true, metadata: { fillReread: { expected: 'Ada', actual: 'Ada' } } },
    )
    expect(result.evidence?.limitUsage?.compoundInputs).toEqual([{ subActionIndex: 0, kind: 'fill', count: 1 }])
  })
})

// -----------------------------------------------------------------------------
// Frozen catalog — the phase's desiredState is a PARAM on an existing tool (counts unchanged)
// -----------------------------------------------------------------------------
describe('frozen tool catalog — EXEC compounds register no tools', () => {
  it('keeps 56 registered / web 33 / android 30 / ios 27', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    expect(registry.getAll()).toHaveLength(56)
    expect(registry.getForPlatform('web')).toHaveLength(33)
    expect(registry.getForPlatform('android')).toHaveLength(30)
    expect(registry.getForPlatform('ios')).toHaveLength(27)
  })
})
