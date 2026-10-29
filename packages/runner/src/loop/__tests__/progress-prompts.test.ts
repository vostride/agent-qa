// the planner prompt judges outcomes, not screen changes. The
// stagnation and cycle-break blocks cannot render, the progress rules are gone, Rule 22 is the
// outcome-evidence rule and Rule 13 allows requested repetition. Rules 10 and 17 were re-pinned
// once by 438, Rule 19 once by 439 and Rule 23 once by 441: the
// 5e3e932a2 bytes stay below for the record.
import { describe, it, expect } from 'vitest'
import type { ModelMessage } from 'ai'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { StepContext } from '../types.js'
import {
  composeTurnMessages,
  buildSystemPrompt,
  buildContextTier,
  buildVolatileTier,
} from '../prompts.js'
import { buildAgentScreenState } from './screen-fixtures.js'

// Copied from buildSystemPrompt('web') at agent-qa 5e3e932a2.
const PINNED_RULES_5E3E932A2: Record<number, string> = {
  10:
    "10. NEVER hallucinate a ref. A ref is a typed current-screen element handle from the observation, never a CSS selector, XPath, label, or guessed description. If an element appears in the observation without [ref=eN] (e.g. `- menuitemradio \"Chinese\"` with no ref), do NOT guess a ref number. Either use tapCoordinate with coordinates and coordSpace from the observation, or interact with a nearby ref'd element. If a tool offers elementDescription, use it only as optional disambiguation; it never replaces the ref or coordinates. Common no-ref cases: dropdown options, shadow DOM content, canvas elements, dynamically inserted items.\n   TARGET DESCRIPTORS: Element-naming tools accept an optional `target` descriptor as an alternative to `ref`. PREFER a ref from the latest observation — it is the fast, exact path. Only when you have no confident ref for the element you must act on, emit a `target` instead of guessing a ref: give it the element's accessible `name` (always required — a nameless target cannot be grounded), plus `role` and `ordinal` when needed to disambiguate same-named elements. Every element-targeting action (click, tap, fill, select, hover, …) MUST carry EXACTLY ONE of `ref` or `target` — NEVER both, and NEVER neither. An action that carries neither a `ref` nor a `target` cannot be grounded and is rejected; do not emit a bare click/tap hoping the system will infer the element. If you have no confident `ref`, you MUST construct a `target` descriptor (accessible `name`, plus `role`/`ordinal` to disambiguate) rather than omitting both. Unlike elementDescription (pure logging), a `target` is grounded by the system against a fresh observation. If a tool call returns a grounding error (the descriptor did not resolve or was ambiguous), re-observe and refine the descriptor or switch to a visible ref/coordinates — do NOT retry the identical call.",
  17:
    "17. AMBIGUITY DETECTION: If you cannot uniquely identify the target element from the step instruction + previous step context + current screen state, set stepFailed with a message listing the ambiguous candidates. Do NOT guess when multiple elements match a generic description (\"the button\", \"the link\", \"the icon\"). A QA engineer asks for clarification rather than guessing — you fail the step. Single match = proceed. Multiple matches with disambiguating context from previous steps = use that context to select. Multiple matches with no context = fail.\n   ASSERTION PRECISION: Read quantity qualifiers carefully before asserting:\n   - \"exists\" / \"is present\" / \"is mentioned\" = at least one match. Multiple matches = pass.\n   - \"only once\" / \"exactly one\" / \"single\" = count must be exactly 1. Multiple = fail.\n   - \"should not exist\" / \"is not shown\" = zero matches. Any match = fail.",
  19:
    "19. ACTION STEP COMPLETION: When the step instruction is a pure action — a single verb like \"click\", \"select\", \"scroll to\", or \"fill\" targeting a specific element — and you found the target element and executed the action successfully, set stepComplete: true immediately. Do NOT retry expecting a visible screen change. Many successful actions produce no visible change on the current page: file downloads save to disk silently, external links open in new tabs, buttons trigger background processes, PDF links open in the browser's PDF viewer. This rule applies to SINGLE-ACTION steps only. If the step has multiple sub-goals (\"click X and then verify Y\"), complete the action sub-goal and move to the next per Rule 13 — do not set stepComplete until ALL sub-goals are done.",
  23:
    "23. SECRET PLACEHOLDERS — the value EXISTS and is bound at dispatch: A step may reference a secret in one of two forms: the template form {{secret:NAME}}, or its redacted display form [secret:NAME] (what you see once model-bound text has been masked). Both mean the same thing: a concrete value for NAME EXISTS and is already bound in this run's secret store. It is hidden from you deliberately, for security — it is NOT missing, NOT unavailable, and NOT a gap you must fill in.\n   TO USE IT: emit the template form {{secret:NAME}} VERBATIM as the action value (e.g. as the value of a fill action). The harness substitutes the real value at dispatch — after you plan, before the action reaches the app. Passing the placeholder through IS the correct, complete action.\n   NEVER declare the step infeasible, skip it, guess, or invent a stand-in because the literal is not visible to you — a hidden secret is not an impossible objective. stepFailed with failureKind \"infeasible\" (Rule 12) stays reserved for genuinely impossible objectives.\n   NEVER attempt to read, print, echo, assert on, or otherwise reveal the concrete secret value. You never need to see it to use it.",
}

const RULE_23_441 =
  '23. SECRETS: [secret:NAME] is a declared secret whose value exists but is hidden from you. ' +
  'To type it, use {{secret:NAME}} verbatim as the action value, never [secret:NAME].'

// Copied from buildSystemPrompt('web') after the 438 rewrite of Rules 10 and 17.
const PINNED_RULES_438: Record<number, string> = {
  10:
    "10. NEVER hallucinate a ref. A ref is a typed current-screen element handle from the observation, never a CSS selector, XPath, label, or guessed description. If an element appears in the observation without [ref=eN] (e.g. `- menuitemradio \"Chinese\"` with no ref), do NOT guess a ref number. Either use tapCoordinate with coordinates and coordSpace from the observation, or interact with a nearby ref'd element. If a tool offers elementDescription, use it only as optional disambiguation; it never replaces the ref or coordinates. Common no-ref cases: dropdown options, shadow DOM content, canvas elements, dynamically inserted items.\n   STATED TARGET: Every element action (click, tap, fill, select, hover, …) carries both `ref` and `target`. `ref` is the element's handle from the latest observation. `target` states the element you mean: its `role` and `name` as the observation shows them, plus `row`, words from its row's ` text: \"…\"`, whenever the same label appears more than once on the screen. Example: three \"Edit label\" buttons, one per address; to edit the Elm Street address, state `{ role: \"button\", name: \"Edit label\", row: \"7 Elm Street\" }`. Before anything is sent, the system compares the two: a ref that is clearly a different element (another kind of control, an unrelated name, a different number, another row) is refused as target-mismatch and nothing happens, so re-observe and use the ref of the element you mean. With no confident ref, send `target` alone and the system grounds it against the current screen. NEVER send neither: an element action with no `ref` and no `target` cannot be grounded and is rejected. `target` never holds a position or index; to act on \"the second\" of identical controls, use that control's ref. Unlike elementDescription (pure logging), `target` is checked. After a grounding error or a target-mismatch, do NOT retry the identical call.",
  17:
    "17. AMBIGUITY DETECTION: If the step instruction, the previous steps and the current screen do not single out exactly one element, set stepFailed with failureKind \"infeasible\" and list the candidates in the reason. NEVER guess among identical controls (\"the button\", \"the link\", \"the icon\"): when the step does not say which, never choose one by position, appearance or what worked before. A QA engineer asks rather than guesses. A single match = proceed. When the step does single one out, by position (\"the second Okay button\"), by region, or by neighbouring row text (\"Elm Street's Edit label\"), act on exactly that element: use its ref and state its row words in target.\n   ASSERTION PRECISION: Read quantity qualifiers carefully before asserting:\n   - \"exists\" / \"is present\" / \"is mentioned\" = at least one match. Multiple matches = pass.\n   - \"only once\" / \"exactly one\" / \"single\" = count must be exactly 1. Multiple = fail.\n   - \"should not exist\" / \"is not shown\" = zero matches. Any match = fail.",
}

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepInstruction: 'Delete all rows',
    testName: 'bulk delete test',
    previousSteps: [],
    plannerModel: {} as never,
    verifierModel: {} as never,
    ...overrides,
  } as StepContext
}

function makeScreen(): ScreenState {
  return buildAgentScreenState({
    tree: '- button "Delete" [ref=e1]',
    elements: [{ ref: 'e1', role: 'button', name: 'Delete', attributes: {} }],
    metadata: { coordSpace: 'viewport', viewportWidth: 390, viewportHeight: 844 },
  })
}

function renderOne(m: ModelMessage): string {
  return typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => ('text' in p && typeof p.text === 'string' ? p.text : '')).join('')
}

function renderTurn(messages: ModelMessage[]): string {
  return messages.map(renderOne).join('\n')
}

function systemText(context: StepContext): string {
  const asText = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c))
  return [
    buildSystemPrompt('web'),
    asText(buildContextTier(context).content),
    asText(buildVolatileTier(context).content),
  ].join('\n')
}

function rulesBlock(platform: Parameters<typeof buildSystemPrompt>[0]): string {
  const prompt = buildSystemPrompt(platform)
  const start = prompt.indexOf('Rules:\n') + 'Rules:\n'.length
  return prompt.slice(start, prompt.indexOf('\n\nCall the tool'))
}

function rule(n: number, platform: Parameters<typeof buildSystemPrompt>[0] = 'web'): string {
  const block = rulesBlock(platform)
  const found = block.indexOf(`\n${n}. `)
  expect(found).toBeGreaterThanOrEqual(0)
  const start = found + 1
  const next = block.indexOf(`\n${n + 1}. `, start)
  return next < 0 ? block.slice(start) : block.slice(start, next)
}

const PLATFORMS = ['web', 'android', 'ios', undefined] as const

describe('prompt rules without screen-change progress checks', () => {
  it('the stagnation and cycle-break blocks never render', () => {
    const legacySlots = {
      stagnation: {
        classification: 'unresponsive',
        anchor: { role: 'button', nameNormalized: 'zzanchorsentinel', ordinal: 0 },
        diff: 'ZZDIFFSENTINEL',
        bannedSubstitutions: [{ anchorKey: 'ZZBANSENTINEL', banned: 'longpress', required: 'tap' }],
      },
      cycleBreak: { revisitedKey: 'ZZKEYSENTINEL', windowSummary: 'ZZWINDOWSENTINEL' },
    }
    const context = makeContext({
      ...(legacySlots as unknown as Partial<StepContext>),
      previousSteps: [{ instruction: 'Open the list', outcome: 'passed' }],
      subActionHistory: [{ action: 'click on ref="e1"', result: 'success', reasoning: 'delete row 1' }],
      failureContext: 'Sub-action 1 failed: Element is disabled',
      workingMemory: [],
      bulkCompletionPredicate: 'until no rows with a delete button remain',
    })
    const turn = renderTurn(composeTurnMessages(context, makeScreen()))
    const system = systemText(context)

    for (const text of [turn, system]) {
      expect(text).not.toContain('Stagnation detected')
      expect(text).not.toContain('Observed diff:')
      expect(text).not.toContain('Cycle detected')
      expect(text).not.toMatch(/ZZ(DIFF|BAN|KEY|WINDOW)SENTINEL|zzanchorsentinel/)
    }
    expect(turn).toContain('until no rows with a delete button remain')
    expect(turn).toContain('Actions already taken for this step:')
  })

  it('Rule 3 has no boundary-means-absent sentence and keeps the toEnd exception', () => {
    for (const platform of PLATFORMS) {
      const rule3 = rule(3, platform)
      expect(rule3.startsWith('3. ')).toBe(true)
      expect(rule3).not.toContain('If you have already scrolled and the screen did not change')
      expect(rule3).not.toContain('the element is not on this page')
      expect(rule3).toContain(
        "EXCEPTION: When the step goal IS to reach the scroll boundary (e.g., 'scroll to the end', 'scroll to the bottom', 'scroll all the way down', 'scroll to the top'), use mode \"direction\" with amount \"toEnd\" — reaching the boundary IS the goal, so set stepComplete: true.",
      )
    }
  })

  it('Rule 8 has no no-screen-change instruction', () => {
    for (const platform of PLATFORMS) {
      const rule8 = rule(8, platform)
      expect(rule8).not.toContain('no screen change')
      expect(rule8).not.toContain('fundamentally different strategy')
      expect(rule8).toContain(
        'Use this to avoid repeating approaches that failed — if an action returned an error or the step was rejected, try a different strategy (different element, different action type, different navigation path).',
      )
    }
  })

  it('the old Rule 22 is gone and Rule 22 is OUTCOME EVIDENCE', () => {
    for (const platform of PLATFORMS) {
      const prompt = buildSystemPrompt(platform)
      expect(prompt).not.toContain('STAGNATION FOCUS')
      expect(prompt).not.toContain('DO NOT WANDER')
      expect(prompt).not.toContain('stagnation block')
      expect(prompt).not.toContain('cycle-break block')

      const rule22 = rule(22, platform)
      expect(rule22.startsWith('22. OUTCOME EVIDENCE:')).toBe(true)
      expect(rule22).toContain('No visible change is not failure, and a visible change is not success.')
      expect(rule22).toContain('check the requested effect')
      expect(rule22).toContain('submit, save, pay or delete')
      expect(rule22).toContain('only when it returned an actual error or there is evidence that it did not happen')
      expect(rule22).toContain('Repetition is fine when the step asks for it')
      expect(rule22).toContain('after the action and one reasonable alternative')
      expect(rule22).toContain('set stepFailed and name the missing outcome')
      expect(rule(23, platform).startsWith('23. SECRETS:')).toBe(true)
    }
  })

  it('Rule 13 allows requested repetition', () => {
    for (const platform of PLATFORMS) {
      const rule13 = rule(13, platform)
      expect(rule13).toContain('do not repeat an action unless the step asks for repetition')
      expect(rule13).not.toContain('do not retry the same action')
    }
  })

  it('Rule 23 is the one-line secrets rule', () => {
    for (const platform of PLATFORMS) expect(rule(23, platform)).toBe(RULE_23_441)
  })

  it('the bulk-completion predicate still renders only in the turn, never the system tiers', () => {
    const context = makeContext({ bulkCompletionPredicate: 'ZZPREDICATESENTINEL' })
    expect(renderTurn(composeTurnMessages(context, makeScreen()))).toContain('ZZPREDICATESENTINEL')
    expect(systemText(context)).not.toContain('ZZPREDICATESENTINEL')
  })

  it('two identical sub-actions on an unchanged screen draw no repetition warning', () => {
    const context = makeContext({
      subActionHistory: [
        { action: 'tap on ref="e1"', result: 'success' },
        { action: 'tap on ref="e1"', result: 'success' },
      ],
    })
    const turn = renderTurn(composeTurnMessages(context, makeScreen()))
    expect(turn).not.toContain('Do NOT repeat')
    expect(turn).not.toContain('no visible change')
  })
})

describe('Rule 19 completion wording', () => {
  it('Rule 19 says completion needs its outcome in evidence', () => {
    for (const platform of PLATFORMS) {
      const rule19 = rule(19, platform)
      expect(rule19.startsWith('19. COMPLETION NEEDS ITS OUTCOME IN EVIDENCE:')).toBe(true)
      expect(rule19).toContain(
        'Set stepComplete: true only when the requested outcome is in evidence, and name that evidence in your reasoning.',
      )
      expect(rule19).toContain(
        'A setting or value that must be saved or kept is proven only by re-reading it after a reload or reopen within this step.',
      )
      expect(rule19).toContain('For a click on a tab, a link or a menu, the outcome is the click landing on its target.')
      expect(rule19).toContain('No visible change is not failure.')
      expect(rule19).toContain('complete the action sub-goal and move to the next per Rule 13')
      expect(rule19).not.toContain('set stepComplete: true immediately')
      expect(rule19).not.toContain('Do NOT retry expecting a visible screen change')
    }
    expect(rule(19, 'web')).toContain('a single action such as "click", "select", "scroll to", or "fill"')
    expect(rule(19, 'ios')).toContain('multiple sub-goals ("tap X and then verify Y")')
  })
})

describe('Rules 10 and 17 wording', () => {
  it('Rules 10 and 17 match their pinned text', () => {
    for (const n of [10, 17]) {
      expect(rule(n, 'web')).toBe(PINNED_RULES_438[n])
    }
  })

  it.each(PLATFORMS)('Rule 17 keeps the no-guessing rule (%s)', (platform) => {
    const text = rule(17, platform)
    const lead = text.slice(0, text.indexOf('\n'))
    const precision = (pinned: string) => pinned.slice(pinned.indexOf('\n   ASSERTION PRECISION:'))

    expect(lead.startsWith('17. AMBIGUITY DETECTION:')).toBe(true)
    expect(lead).toContain('failureKind "infeasible" and list the candidates')
    expect(lead).toContain(
      'when the step does not say which, never choose one by position, appearance or what worked before',
    )
    expect(precision(text)).toBe(precision(PINNED_RULES_5E3E932A2[17] as string))
  })
})
