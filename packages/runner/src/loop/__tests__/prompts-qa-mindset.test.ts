// Ported from core/src/agent/__tests__/prompts-qa-mindset.test.ts (353-03, D-02).
// Adaptation: D-10 dropped healingConfig from StepContext — removed from fixtures.
//
// 355-02 reconciliation (Wave-0, RED pending Plans 03/06): buildSystemPrompt assertions
// (rules 1-21) are untouched — the planner stable tier is byte-preserving. The retired
// monolithic step-prompt builder's sub-action assertion is redirected to
// `composeTurnMessages`. The verifier prompt splits (D-11): the byte-stable verdict-
// identity preamble + fixed verification-approach/screenshot prose move to
// `buildVerifierStableTier()` (the Plan-06 verifier stable tier); the per-call before/
// after states + formatted action stay on `buildVerificationPrompt(...)`. Every asserted
// string is preserved byte-for-byte — only which producer it is checked against changes.
import { describe, it, expect } from 'vitest'
import type { ModelMessage, SystemModelMessage } from 'ai'
import {
  buildSystemPrompt,
  buildVerificationPrompt,
  // Plan-03/06 tier/turn API — intentionally unresolved today (the RED reason):
  buildVerifierStableTier,
  composeTurnMessages,
} from '../prompts.js'
import type { ScreenState } from '@vostride/agent-qa-schema'
import { asRef } from '@vostride/agent-qa-schema'
import type { StepContext } from '../types.js'
import { buildAgentScreenState } from './screen-fixtures.js'

// Render the verifier stable tier's text (string or SystemModelMessage) for `.toContain`.
function stableText(tier: string | SystemModelMessage): string {
  if (typeof tier === 'string') return tier
  return typeof tier.content === 'string' ? tier.content : JSON.stringify(tier.content)
}

// Concatenate the text parts of the per-turn ModelMessage[] into one rendered string.
function renderTurn(messages: ModelMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
            .join(''),
    )
    .join('\n')
}

describe('QA mindset prompt rules', () => {
  const systemPrompt = buildSystemPrompt()

  // AGENT-QA-01: always move forward for multi-action steps
  describe('always move forward', () => {
    it('buildSystemPrompt contains forward progress rule', () => {
      expect(systemPrompt).toContain('ALWAYS MOVE FORWARD')
    })

    it('buildSystemPrompt teaches assert is not forward progress', () => {
      expect(systemPrompt).toContain('assert is NOT forward progress')
    })

    it('buildSystemPrompt teaches to break step into sub-goals and execute in order', () => {
      expect(systemPrompt).toContain('Break the step instruction into sub-goals')
      expect(systemPrompt).toContain('MOVE to the next sub-goal')
    })

    it('buildSystemPrompt allows requested repetition (Rule 13)', () => {
      expect(systemPrompt).toContain('do not repeat an action unless the step asks for repetition')
      expect(systemPrompt).not.toContain('do not retry the same action')
    })

    it('buildSystemPrompt judges outcomes, not screen changes (Rule 22)', () => {
      expect(systemPrompt).toContain('22. OUTCOME EVIDENCE:')
      expect(systemPrompt).toContain('No visible change is not failure, and a visible change is not success.')
      expect(systemPrompt).not.toContain('STAGNATION FOCUS')
    })
  })

  // ASSERT-ROUTE-01 (Phase 360 §12.2 reconciliation): Rule 12 now teaches the assertValue /
  // assertAI split and the reportValue answer channel + same-call verdict (was: the retired
  // assert-verb no-op coaching). Assertions preserved in spirit, re-targeted to the shipped
  // vocabulary — never weakened.
  describe('§12.2 assertValue/assertAI split and same-call verdict', () => {
    it('Rule 12 routes deterministic value checks to assertValue', () => {
      expect(systemPrompt).toContain('DETERMINISTIC VALUE CHECKS')
      expect(systemPrompt).toContain('assertValue')
    })

    it('Rule 12 requires verdict in the SAME tool call', () => {
      expect(systemPrompt).toContain('SAME tool call')
    })

    it('Rule 12 routes claim-shaped or visual judgments to assertAI', () => {
      expect(systemPrompt).toContain('CLAIM-SHAPED OR VISUAL JUDGMENTS')
      expect(systemPrompt).toContain('assertAI')
    })

    it('Rule 12 handles multi-part steps where more sub-goals remain', () => {
      expect(systemPrompt).toContain('more sub-goals remain')
    })

    it('Rule 12 exposes the reportValue answer channel distinct from stepComplete', () => {
      expect(systemPrompt).toContain('reportValue')
      expect(systemPrompt).toContain('DISTINCT from stepComplete')
    })
  })

  // ASSERT-FAIL-01: assertion failure handling — infeasible terminal + strict literal + report-truth
  describe('assertion failure handling', () => {
    it('Rule 12 declares infeasible as a typed terminal outcome', () => {
      expect(systemPrompt).toContain('IMPOSSIBLE OBJECTIVE')
      expect(systemPrompt).toContain('failureKind "infeasible"')
    })

    it('Rule 12 blocks a setVariable sidestep for assertion failures', () => {
      expect(systemPrompt).toContain('do NOT store a value via setVariable to sidestep it')
    })

    it('Rule 12 contains strict literal assertion section', () => {
      expect(systemPrompt).toContain('STRICT LITERAL ASSERTION')
      expect(systemPrompt).toContain('check the EXACT condition from the step text')
    })

    it('Rule 12 enforces QA mindset on assertions -- report truth not make tests pass', () => {
      expect(systemPrompt).toContain('step text is the test spec')
      expect(systemPrompt).toContain('report truth, not make tests pass')
    })
  })

  // AGENT-QA-02: trust ARIA tree, verify with screenshots
  describe('trust but verify', () => {
    it('buildSystemPrompt contains trust-but-verify rule', () => {
      expect(systemPrompt).toContain('TRUST THE ARIA TREE, VERIFY WITH SCREENSHOTS')
    })

    it('buildSystemPrompt requires scrolling to target before asserting', () => {
      expect(systemPrompt).toContain('SCROLL to bring it into view first')
      expect(systemPrompt).toContain('scroll up for content at the top')
      expect(systemPrompt).toContain('scroll down for content at the bottom')
    })

    it('buildSystemPrompt requires scrolling to visually confirm quantity assertions', () => {
      expect(systemPrompt).toContain('MUST scroll through the entire content to visually confirm')
      expect(systemPrompt).toContain('cannot verify quantity from the ARIA tree alone')
    })

    it('buildSystemPrompt distinguishes ARIA tree for navigation vs screenshot for verification', () => {
      expect(systemPrompt).toContain('ARIA tree tells you WHERE things are')
      expect(systemPrompt).toContain('screenshot tells you what the user ACTUALLY SEES')
    })
  })

  // AGENT-QA-03: QA mindset concept
  describe('QA mindset', () => {
    it('buildSystemPrompt contains QA mindset concept', () => {
      expect(systemPrompt).toContain('QA MINDSET')
    })

    it('a verification turn with a screenshot requires visual evidence for quantity claims', () => {
      // 2026-10-11 (439-03): the screenshot-analysis prose rides only a turn that has an image.
      const state = buildAgentScreenState({ tree: 'button "Go"', elements: [], url: '', timestamp: 0 })
      const action = { type: 'click' as const, ref: asRef('e1') }
      const turn = buildVerificationPrompt('Go', state, state, action, true)
      expect(turn).toContain('visual evidence')
      expect(turn).toContain('takes precedence')
      expect(turn).toContain('only confirm what you can count')
      expect(stableText(buildVerifierStableTier())).not.toContain('only confirm what you can count')
    })

    it('verifier stable tier keeps the absence-of-change rule and states the per-condition contract', () => {
      const stable = stableText(buildVerifierStableTier())
      expect(stable).toContain('Absence of visible screen change is NOT evidence of failure')
      expect(stable).toContain('Requested conditions:')
      expect(stable).not.toContain('NEGATIVE evidence')
      expect(stable).not.toContain('For every other step')
    })

    it('buildVerificationPrompt enriches action with element context', () => {
      const state: ScreenState = buildAgentScreenState({
        tree: 'button "file-pdf"',
        elements: [{ ref: 'e113', role: 'button', name: 'file-pdf', attributes: {} }],
        url: '',
        timestamp: 0,
        metadata: { coordSpace: 'viewport', viewportWidth: 0, viewportHeight: 0 },
      })
      const action = { type: 'click' as const, ref: asRef('e113') }
      const output = buildVerificationPrompt('click the pdf icon', state, state, action, false)
      expect(output).toContain('button "file-pdf"')
    })
  })

  // AGENT-QA-04: progressive escalation on verification failure
  describe('progressive escalation', () => {
    it('buildSystemPrompt contains progressive escalation ladder', () => {
      expect(systemPrompt).toContain('1st rejection')
      expect(systemPrompt).toContain('DIFFERENT APPROACH')
      expect(systemPrompt).toContain('2nd rejection')
      expect(systemPrompt).toContain('3rd')
      expect(systemPrompt).toContain('stepFailed')
    })

    it('buildSystemPrompt escalation references stepFailed as final escape', () => {
      expect(systemPrompt).toContain('VERIFICATION FAILURE RECOVERY')
      expect(systemPrompt).toContain('stepFailed')
    })
  })

  // STEP-CTX-01: cross-step context
  describe('cross-step context', () => {
    it('buildSystemPrompt contains Rule 16 cross-step context', () => {
      expect(systemPrompt).toContain('CROSS-STEP CONTEXT')
    })

    it('Rule 16 references Previous steps in this test section', () => {
      expect(systemPrompt).toContain('Previous steps in this test')
    })
  })

  // STEP-AMBIG-01: ambiguity detection
  describe('ambiguity detection', () => {
    it('buildSystemPrompt contains Rule 17 ambiguity detection', () => {
      expect(systemPrompt).toContain('AMBIGUITY DETECTION')
    })

    it('Rule 17 contains stepFailed and listing the ambiguous candidates', () => {
      expect(systemPrompt).toContain('stepFailed')
      // 438 Rules 10 and 17 re-pin: the candidates ride an infeasible failure's reason.
      expect(systemPrompt).toContain('failureKind "infeasible" and list the candidates')
    })

    it('Rule 17 contains ASSERTION PRECISION subsection', () => {
      expect(systemPrompt).toContain('ASSERTION PRECISION')
    })

    it('assertion precision teaches at least one match, count must be exactly 1, zero matches', () => {
      expect(systemPrompt).toContain('at least one match')
      expect(systemPrompt).toContain('count must be exactly 1')
      expect(systemPrompt).toContain('zero matches')
    })
  })

  // SCROLL-01: system prompt uses new scroll terminology
  describe('scroll terminology', () => {
    it('buildSystemPrompt Rule 3 references intent-first scroll modes (untilVisible / direction+amount)', () => {
      expect(systemPrompt).toContain('untilVisible')
      expect(systemPrompt).toContain('direction')
      expect(systemPrompt).toContain('amount')
      expect(systemPrompt).not.toContain('scrollType')
    })

    it('Rule 3 contains boundary-is-goal exception for scroll-to-end steps', () => {
      expect(systemPrompt).toContain('scroll to the end')
      expect(systemPrompt).toContain('scroll to the bottom')
      expect(systemPrompt).toContain('scroll to the top')
      expect(systemPrompt).toContain('stepComplete: true')
      expect(systemPrompt).toContain('reaching the boundary IS the goal')
    })

    it('Rule 3 no longer reads an unchanged scroll as absence; Rule 8 keeps target-confirmed-absent', () => {
      expect(systemPrompt).not.toContain('the element is not on this page')
      expect(systemPrompt).toContain('Target confirmed absent')
      expect(systemPrompt).toContain('stepFailed')
    })

    it('boundary-is-goal exception present in web platform prompt', () => {
      const webPrompt = buildSystemPrompt('web')
      expect(webPrompt).toContain('scroll to the end')
      expect(webPrompt).toContain('stepComplete: true')
      expect(webPrompt).toContain('stepFailed')
    })
  })

  // AGENT-LOOP-01: step completion recognition via sub-action history
  describe('step completion recognition', () => {
    it('Rule 13 references sub-action history for step completion', () => {
      expect(systemPrompt).toContain('Review your previous actions')
      expect(systemPrompt).toContain('set stepComplete: true immediately')
    })

    it('composeTurnMessages renders reasoning in sub-action history', () => {
      const state: ScreenState = buildAgentScreenState({
        tree: 'button "OK"',
        elements: [],
        url: '',
        timestamp: 0,
        metadata: { coordSpace: 'viewport', viewportWidth: 0, viewportHeight: 0 },
      })
      const context: StepContext = {
        stepInstruction: 'tap OK',
        testName: 'test',
        previousSteps: [],
        plannerModel: {} as any,
        verifierModel: {} as any,
        subActionHistory: [
          { action: 'tap on ref="e1"', reasoning: 'Tapped OK to confirm', result: 'success' },
        ],
      }
      const prompt = renderTurn(composeTurnMessages(context, state))
      expect(prompt).toContain('Tapped OK to confirm')
      expect(prompt).toContain('tap on ref="e1"')
    })
  })
})
