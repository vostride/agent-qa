import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildStepPrompt, buildVerificationPrompt } from '../prompts.js'
import type { ScreenState } from '../../types/platform.js'
import type { StepContext } from '../types.js'

describe('QA mindset prompt rules', () => {
  const systemPrompt = buildSystemPrompt()

  // AGENT-QA-01: always move forward for multi-action steps
  describe('AGENT-QA-01 — always move forward', () => {
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
  })

  // ASSERT-LOOP-01: assert action is a no-op, verdict must be in same tool call
  describe('ASSERT-LOOP-01 — assert no-op and same-call verdict', () => {
    it('Rule 12 states assert is a no-op', () => {
      expect(systemPrompt).toContain('Assert is a no-op')
    })

    it('Rule 12 requires verdict in the SAME tool call', () => {
      expect(systemPrompt).toContain('SAME tool call')
    })

    it('Rule 12 prohibits assert with stepComplete: false', () => {
      expect(systemPrompt).toContain('NEVER output assert with stepComplete: false')
    })

    it('Rule 12 handles multi-part steps where assert is a precondition', () => {
      expect(systemPrompt).toContain('more sub-goals remain')
    })

    it('Rule 12 explains infinite loop consequence', () => {
      expect(systemPrompt).toContain('infinite loop with no new information')
    })
  })

  // ASSERT-FAIL-01: assertion failure handling for non-visual conditions
  describe('ASSERT-FAIL-01 -- assertion failure handling', () => {
    it('Rule 12 contains assertion failure section for non-visual conditions', () => {
      expect(systemPrompt).toContain('ASSERTION FAILURE FOR NON-VISUAL CONDITIONS')
    })

    it('Rule 12 blocks setVariable/scroll/navigate for assertion failures (per D-04)', () => {
      expect(systemPrompt).toContain('Do NOT use setVariable, scroll, navigate, or any other action')
      expect(systemPrompt).toContain('stepFailed is the ONLY correct response')
    })

    it('Rule 12 contains strict literal assertion section (per D-05)', () => {
      expect(systemPrompt).toContain('STRICT LITERAL ASSERTION')
      expect(systemPrompt).toContain('Assert the EXACT condition from the step text')
    })

    it('Rule 12 enforces QA mindset on assertions -- report truth not make tests pass (per D-06)', () => {
      expect(systemPrompt).toContain('step text is the test spec')
      expect(systemPrompt).toContain('report truth, not make tests pass')
    })
  })

  // AGENT-QA-02: trust ARIA tree, verify with screenshots
  describe('AGENT-QA-02 — trust but verify', () => {
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
  describe('AGENT-QA-03 — QA mindset', () => {
    it('buildSystemPrompt contains QA mindset concept', () => {
      expect(systemPrompt).toContain('QA MINDSET')
    })

    it('buildVerificationPrompt with screenshot requires visual evidence for quantity claims', () => {
      const state: ScreenState = {
        tree: 'button "OK"',
        elements: [],
        url: '',
        timestamp: 0,
        metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
      }
      const action = { type: 'click' as const, ref: 'e1' }
      const output = buildVerificationPrompt('verify result', state, state, action, true)
      expect(output).toContain('visual evidence')
      expect(output).toContain('takes precedence')
      expect(output).toContain('only confirm what you can count')
    })

    it('buildVerificationPrompt teaches negative evidence approach', () => {
      const state: ScreenState = {
        tree: 'button "OK"',
        elements: [],
        url: '',
        timestamp: 0,
        metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
      }
      const action = { type: 'click' as const, ref: 'e1' }
      const output = buildVerificationPrompt('click the button', state, state, action, false)
      expect(output).toContain('NEGATIVE evidence')
      expect(output).toContain('Absence of visible screen change is NOT evidence of failure')
      expect(output).toContain('action steps')
      expect(output).toContain('verification/assertion steps')
    })

    it('buildVerificationPrompt enriches action with element context', () => {
      const state: ScreenState = {
        tree: 'button "file-pdf"',
        elements: [{ ref: 'e113', role: 'button', name: 'file-pdf', attributes: {} }],
        url: '',
        timestamp: 0,
        metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
      }
      const action = { type: 'click' as const, ref: 'e113' }
      const output = buildVerificationPrompt('click the pdf icon', state, state, action, false)
      expect(output).toContain('button "file-pdf"')
    })
  })

  // AGENT-QA-04: progressive escalation on verification failure
  describe('AGENT-QA-04 — progressive escalation', () => {
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
  describe('STEP-CTX-01 -- cross-step context', () => {
    it('buildSystemPrompt contains Rule 16 cross-step context', () => {
      expect(systemPrompt).toContain('CROSS-STEP CONTEXT')
    })

    it('Rule 16 references Previous steps in this test section', () => {
      expect(systemPrompt).toContain('Previous steps in this test')
    })
  })

  // STEP-AMBIG-01: ambiguity detection
  describe('STEP-AMBIG-01 -- ambiguity detection', () => {
    it('buildSystemPrompt contains Rule 17 ambiguity detection', () => {
      expect(systemPrompt).toContain('AMBIGUITY DETECTION')
    })

    it('Rule 17 contains stepFailed and listing the ambiguous candidates', () => {
      expect(systemPrompt).toContain('stepFailed')
      expect(systemPrompt).toContain('listing the ambiguous candidates')
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
  describe('SCROLL-01 — scroll terminology', () => {
    it('buildSystemPrompt Rule 3 references scrollType and signed value', () => {
      expect(systemPrompt).toContain('scrollType')
      expect(systemPrompt).toContain('positive value')
      expect(systemPrompt).toContain('negative value')
    })

    it('Rule 3 contains boundary-is-goal exception for scroll-to-end steps', () => {
      expect(systemPrompt).toContain('scroll to the end')
      expect(systemPrompt).toContain('scroll to the bottom')
      expect(systemPrompt).toContain('scroll to the top')
      expect(systemPrompt).toContain('stepComplete: true')
      expect(systemPrompt).toContain('reaching the boundary IS the goal')
    })

    it('Rule 3 preserves stepFailed for search-not-found case', () => {
      expect(systemPrompt).toContain('stepFailed')
      expect(systemPrompt).toContain('target content was not found')
    })

    it('boundary-is-goal exception present in web platform prompt', () => {
      const webPrompt = buildSystemPrompt('web')
      expect(webPrompt).toContain('scroll to the end')
      expect(webPrompt).toContain('stepComplete: true')
      expect(webPrompt).toContain('stepFailed')
    })
  })

  // AGENT-LOOP-01: step completion recognition via sub-action history
  describe('AGENT-LOOP-01 — step completion recognition', () => {
    it('Rule 13 references sub-action history for step completion', () => {
      expect(systemPrompt).toContain('Review your previous actions')
      expect(systemPrompt).toContain('set stepComplete: true immediately')
    })

    it('buildStepPrompt renders reasoning in sub-action history', () => {
      const state: ScreenState = {
        tree: 'button "OK"',
        elements: [],
        url: '',
        timestamp: 0,
        metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
      }
      const context: StepContext = {
        stepInstruction: 'tap OK',
        testName: 'test',
        previousSteps: [],
        plannerModel: {} as any,
        verifierModel: {} as any,
        healingConfig: { maxAttempts: 3 },
        subActionHistory: [
          { action: 'tap on ref="e1"', reasoning: 'Tapped OK to confirm', result: 'success' },
        ],
      }
      const prompt = buildStepPrompt('tap OK', state, context)
      expect(prompt).toContain('Tapped OK to confirm')
      expect(prompt).toContain('tap on ref="e1"')
    })
  })
})
