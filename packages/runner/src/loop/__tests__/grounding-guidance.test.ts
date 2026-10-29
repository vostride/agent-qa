// pins the planner GROUNDING GUIDANCE so the
// `ungroundable_action` bare-click regression (365-VALIDATION.md:136-146) cannot silently
// return. During the 2026-07-08 live run the planner emitted a `click` carrying NEITHER a
// `ref` NOR a `{role,name}` target; the gate correctly minted `descriptor_invalid`, the
// one-shot retry repeated the bare click, and the step failed structured
// `ungroundable_action`. Root cause (RESEARCH Q8 candidate #1, evidenced by the
// grounding-capture harness): the ref|target guidance only said "NEVER both" — it never
// forbade emitting NEITHER, and gave no `target`-fallback mandate, so a model without a
// confident ref emitted a bare action.
//
// These tests are guidance-only regression guards. They assert nothing about the gate's
// ref-and-target rule (438 D-01 replaced exactly-one-of), the one-shot retry, or the
// ungroundable_action shape — the shipped GROUND-01..03 contracts stay fixed.
//
// RED (before the prompts.ts fix): Test 1 fails — the assembled system prompt forbids only
// "both" and never mentions "neither" nor mandates a target fallback. Tests 2 and 3 already
// pass (the tool docs + descriptor_invalid feedback already name the two remedies) and stand
// as guards against future weakening.
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../prompts.js'
import { defaultRegistry } from '../../tools/index.js'
import { groundingError } from '../../tools/errors.js'

// The STATED TARGET paragraph runs from its header to the next numbered rule.
function targetDescriptorGuidance(platform: 'web' | 'android' | 'ios'): string {
  const sp = buildSystemPrompt(platform)
  const start = sp.indexOf('STATED TARGET')
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = sp.slice(start)
  const end = rest.search(/\n\s*\d+\.\s/)
  return end > 0 ? rest.slice(0, end) : rest
}

describe('planner grounding guidance', () => {
  // Test 1 (behavior block Test 1): the system guidance requires ref and target on every
  // element action, forbids emitting NEITHER, sends a target alone only with no
  // confident ref, and says a clearly different ref is refused as target-mismatch.
  it.each(['web', 'android', 'ios'] as const)(
    'system prompt mandates exactly-one ref|target and forbids neither (%s)',
    (platform) => {
      const guidance = targetDescriptorGuidance(platform)
      expect(guidance).toMatch(/every element action[^.]*carries both `ref` and `target`/i)
      expect(guidance).toMatch(/never send neither/i)
      expect(guidance).toMatch(/with no confident ref, send `target` alone/i)
      expect(guidance).toMatch(/clearly a different element[^.]*refused as target-mismatch/i)
    },
  )

  // Test 2 (behavior block Test 2): the descriptor_invalid (exactly-one) feedback text — the
  // §7.1 message the one-shot retry injects — names BOTH remedies (cite a ref / provide a
  // role+name target) so the retry can actually correct rather than repeat the mistake.
  it('descriptor_invalid exactly-one feedback names both remedies (ref and target)', () => {
    const err = groundingError.descriptorInvalid('click', 'no-handle')
    const feedback = `${err.message} ${err.hint}`
    expect(feedback).toMatch(/\bref\b/i)
    expect(feedback).toMatch(/\btarget\b/i)
    expect(feedback).toMatch(/no confident ref/i)
  })

  // Test 3 (behavior block Test 3 — root cause is guidance-side, not observation-side, so
  // this guards the tool-surface guidance rather than tree serialization): the click/tap tool
  // descriptions instruct providing a ref OR a role+name target and forbid both, so the two
  // valid remedies are visible on the tool surface the model calls, not only in the prose rules.
  it.each([
    ['web', 'web_click'],
    ['android', 'mobile_tap'],
    ['ios', 'mobile_tap'],
  ] as const)('the %s element-targeting tool doc names ref and target as the remedies (%s)', (platform, toolId) => {
    const line = defaultRegistry
      .generateDocs(platform)
      .split('\n')
      .find((l) => l.startsWith(`- ${toolId}:`))
    expect(line, `expected a doc line for ${toolId} on ${platform}`).toBeDefined()
    expect(line as string).toMatch(/\bref\b/i)
    expect(line as string).toMatch(/\btarget\b/i)
    expect(line as string).toMatch(/alongside ref/i)
    expect(line as string).toMatch(/no confident ref, send target alone/i)
  })
})
