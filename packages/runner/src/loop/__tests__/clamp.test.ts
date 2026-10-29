// Wave-0 (test-first) scaffold for Phase 355 CTXB-04 — the dynamic output clamp
// (max_output = max(floor, min(default, C − I − safety))), the proactive/reactive
// degrade wiring, the observation+instruction pins, retry-once on a live overflow,
// the recordUsage feed, and the structured cannot-fit outcome (never a crash).
//
// RED BY DESIGN: the '../clamp.js' module does not exist until Plan 04 authors it.
// The whole suite is RED for exactly that reason (missing clamp module) — never a
// typo or a wrong fixture. The fake TokenAccounting port is real (loop-harness), so
// once Plan 04 lands clamp.ts these turn GREEN.
//
// Contract these tests pin (per CONTEXT D-01/D-02/D-10/D-14/D-17) for the Plan-04 clamp.ts:
//   - computeSafety(contextWindow) → max(256, ceil(0.02 * contextWindow))  (percentage + floor, D-02)
//   - computeMaxOutput({ contextWindow, inputTokens, defaultMaxOutput, safety?, floor? })
//        → max(floor ?? 256, min(defaultMaxOutput, contextWindow − inputTokens − safety))   (D-01)
//   - estimateInput(accounting, messages, toolSchemaJson?) → accounting.estimate(messages)
//        + tool-schema tokens (the port's estimate() does NOT count tool schemas, §5.1)
//   - executeClampedCall({ accounting, system, messages, toolSchema, pin, call, isOverflow? })
//        → proactive pre-degrade when estimate > budget; forwards { budget, pin } to degrade;
//          reactive isOverflow → re-degrade → retry ONCE (non-overflow rethrows); recordUsage
//          once per successful response; surfaces the structured cannot-fit outcome (D-17).
import { describe, it, expect, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import { makeFakeTokenAccounting } from './loop-harness.js'
import {
  // Plan-04 clamp module — intentionally unresolved today (the RED reason for this suite):
  computeSafety,
  computeMaxOutput,
  estimateInput,
  executeClampedCall,
} from '../clamp.js'

const OK_USAGE = { usage: { inputTokens: 100, outputTokens: 20 } }

describe('clamp arithmetic — safety policy', () => {
  it('sets safety = max(256, ceil(0.02 * C)) and scales with the window', () => {
    // 4k local model: 2% of 4096 = 82 → the 256 absolute floor wins.
    expect(computeSafety(4096)).toBe(256)
    // 1M model: 2% of 1_000_000 = 20_000 → the percentage dominates.
    expect(computeSafety(1_000_000)).toBe(20_000)
    // Monotonic in C (a larger window reserves a larger safety margin).
    expect(computeSafety(1_000_000)).toBeGreaterThan(computeSafety(50_000))
  })
})

describe('clamp arithmetic — maxOutput', () => {
  it('computes max(floor, min(default, C − I − safety)) for representative windows', () => {
    // 4k-window local model: headroom comfortably above default.
    expect(
      computeMaxOutput({ contextWindow: 4096, inputTokens: 1000, defaultMaxOutput: 1024, safety: 256 }),
    ).toBe(1024)
    // 1M-window model: default caps the (huge) headroom.
    expect(
      computeMaxOutput({ contextWindow: 1_000_000, inputTokens: 500_000, defaultMaxOutput: 8192, safety: 20_000 }),
    ).toBe(8192)
  })

  it('clamps up to the floor (never zero/negative) when C − I − safety is tiny/negative', () => {
    const out = computeMaxOutput({ contextWindow: 4096, inputTokens: 4000, defaultMaxOutput: 1024, safety: 256 })
    // C − I − safety = −160 → clamps up to the 256 floor rather than emitting a negative cap.
    expect(out).toBe(256)
    expect(out).toBeGreaterThan(0)
  })
})

describe('input estimate includes tool schemas (§5.1)', () => {
  it('adds tool-schema tokens to I, lowering the resulting maxOutput', () => {
    const acc = makeFakeTokenAccounting({ estimate: (m) => JSON.stringify(m).length })
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
    const toolSchema = JSON.stringify({ tool: 'x'.repeat(400) })

    const withoutTools = estimateInput(acc, messages)
    const withTools = estimateInput(acc, messages, toolSchema)
    expect(withTools).toBeGreaterThan(withoutTools)

    const baseOut = computeMaxOutput({ contextWindow: 10_000, inputTokens: withoutTools, defaultMaxOutput: 4096, safety: 256 })
    const toolOut = computeMaxOutput({ contextWindow: 10_000, inputTokens: withTools, defaultMaxOutput: 4096, safety: 256 })
    expect(toolOut).toBeLessThanOrEqual(baseOut)
  })
})

describe('proactive degrade + pins', () => {
  it('degrades before the call when estimate > budget, pinning observation + instruction', async () => {
    const observation: ModelMessage = { role: 'user', content: 'OBSERVATION: latest screen tree' }
    const instruction: ModelMessage = { role: 'user', content: 'Current step: "click Sign In"' }
    const previousSteps: ModelMessage = { role: 'user', content: 'Previous steps in this test: ...' }
    const messages: ModelMessage[] = [previousSteps, observation, instruction]

    const pinned = new Set<ModelMessage>([observation, instruction])
    const pin = (m: ModelMessage) => pinned.has(m)

    // estimate (5000) far exceeds the budget derived from a 1000-token window → proactive fire.
    const acc = makeFakeTokenAccounting({ contextWindow: 1000, maxOutput: 500, estimate: 5000 })
    const call = vi.fn().mockResolvedValue(OK_USAGE)

    await executeClampedCall({ accounting: acc, system: [], messages, toolSchema: '', pin, call })

    expect(acc.degradeCalls.length).toBeGreaterThanOrEqual(1)
    const passedPin = acc.degradeCalls[0].options.pin
    expect(passedPin).toBeTypeOf('function')
    // The pin protects the observation and instruction, but not the trim-eligible history.
    expect(passedPin!(observation, messages.indexOf(observation))).toBe(true)
    expect(passedPin!(instruction, messages.indexOf(instruction))).toBe(true)
    expect(passedPin!(previousSteps, messages.indexOf(previousSteps))).toBe(false)
  })
})

describe('reactive overflow retry-once', () => {
  it('re-degrades against the shrunk window and retries the call exactly once on overflow', async () => {
    const acc = makeFakeTokenAccounting({ contextWindow: 4096, maxOutput: 1024, estimate: 100 })
    const isOverflow = (e: unknown) => e instanceof Error && /context length/i.test(e.message)
    const messages: ModelMessage[] = [{ role: 'user', content: 'x' }]

    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("model's maximum context length is 4096 tokens"))
      .mockResolvedValueOnce(OK_USAGE)

    const res = await executeClampedCall({ accounting: acc, system: [], messages, toolSchema: '', pin: () => false, call, isOverflow })

    expect(call).toHaveBeenCalledTimes(2)
    expect(res.result).toBeDefined()
  })

  it('rethrows a non-overflow error unchanged (no retry)', async () => {
    const acc = makeFakeTokenAccounting({ contextWindow: 4096, maxOutput: 1024, estimate: 100 })
    const isOverflow = (e: unknown) => e instanceof Error && /context length/i.test(e.message)
    const messages: ModelMessage[] = [{ role: 'user', content: 'x' }]

    const call = vi.fn().mockRejectedValueOnce(new Error('503 Overloaded'))

    await expect(
      executeClampedCall({ accounting: acc, system: [], messages, toolSchema: '', pin: () => false, call, isOverflow }),
    ).rejects.toThrow('Overloaded')
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('usage anchor', () => {
  it('calls recordUsage exactly once per successful response with the full sent message set', async () => {
    const acc = makeFakeTokenAccounting({ estimate: 100 })
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
    const call = vi.fn().mockResolvedValue({ usage: { inputTokens: 50, outputTokens: 5 } })

    await executeClampedCall({
      accounting: acc,
      system: [{ role: 'system', content: 'identity' }],
      messages,
      toolSchema: '',
      pin: () => false,
      call,
    })

    expect(acc.recordUsageCalls).toHaveLength(1)
    expect(acc.recordUsageCalls[0].messages.length).toBeGreaterThan(0)
  })
})

describe('cannot-fit outcome, never a crash', () => {
  it('surfaces the structured pinned-content-exceeds-budget outcome without throwing', async () => {
    const observation: ModelMessage = { role: 'user', content: 'OBSERVATION: latest screen' }
    const messages: ModelMessage[] = [observation]

    // estimate forces a proactive degrade; degrade reports the pinned set alone overflows.
    const acc = makeFakeTokenAccounting({
      contextWindow: 1000,
      maxOutput: 500,
      estimate: 5000,
      degrade: (msgs) => ({ ok: false, reason: 'pinned-content-exceeds-budget', messages: msgs }),
    })
    const call = vi.fn().mockResolvedValue(OK_USAGE)

    // Must resolve (best-effort) and surface the structured reason — never throw (D-17).
    const res = await executeClampedCall({
      accounting: acc,
      system: [],
      messages,
      toolSchema: '',
      pin: () => true,
      call,
    })

    expect(res.degrade?.ok).toBe(false)
    expect(res.degrade?.reason).toBe('pinned-content-exceeds-budget')
  })
})
