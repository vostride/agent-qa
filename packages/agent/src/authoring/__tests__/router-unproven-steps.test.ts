// C439-ROUTER-UNPROVEN (439 D-07): a member whose failing step the verifier left unproven, with no
// mechanics signal, routes to the stop arm as indefinitive-failure, never to repair. A not-met
// block keeps today's clean-definitive route, an infeasible step keeps its termination's repair
// route (D-08), a member timeout keeps its mechanics route, and a limit stop keeps rule 1b.

import { guardCompletedRunHandoff } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  ConditionVerdict,
  ConditionVerdictsEvidence,
  DraftRef,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { classifyFailureEvidence, routeRepairOrStop, stepUnproven } from '../router.js'
import { ACCEPT_CONTROL_DRAFT, LOCAL_FORM_URL, runDocument } from './evidence-fixtures.js'
import type { MemberFixture, SubActionFixture } from './evidence-fixtures.js'

const DRAFT_REF: DraftRef = {
  filePath: ACCEPT_CONTROL_DRAFT.filePath,
  testId: ACCEPT_CONTROL_DRAFT.testId,
  testName: ACCEPT_CONTROL_DRAFT.testName,
  contentDigest: ACCEPT_CONTROL_DRAFT.contentDigest,
}

const STEPS: readonly (readonly SubActionFixture[])[] = [
  [{ type: 'fill', ref: 'e1', role: 'textbox', name: 'username' }],
  [{ type: 'click', ref: 'e2', role: 'button', name: 'Save', urlAfter: LOCAL_FORM_URL }],
]

const UNVERIFIED_REASON = 'Unverified: "the setting is saved" (no re-read after reload)'

function block(
  verdict: ConditionVerdict,
  ending: ConditionVerdictsEvidence['ending'] = 'completion',
): ConditionVerdictsEvidence {
  return {
    ending,
    conditions: [
      {
        quote: 'the setting is saved',
        verdict,
        ...(verdict === 'met' ? {} : { judged: 'met' as const, guard: 'no-reload' as const }),
        reason: 'no re-read after reload',
        citations: [],
      },
    ],
  }
}

function member(overrides: Partial<MemberFixture> = {}): MemberFixture {
  return {
    filePath: DRAFT_REF.filePath,
    testName: DRAFT_REF.testName,
    outcome: 'failed',
    steps: STEPS,
    failedSteps: [1],
    ...overrides,
  }
}

function handoffWith(
  fixture: MemberFixture,
  conditionVerdicts: ConditionVerdictsEvidence,
  stepIndex = 1,
): CompletedRunHandoff {
  const handoff = runDocument('r_router-439-unproven', [fixture])
  const step = handoff.tests[0].steps[stepIndex]
  step.conditionVerdicts = conditionVerdicts
  step.verifierVerdict = { pass: false, reasoning: UNVERIFIED_REASON }
  expect(() => guardCompletedRunHandoff(JSON.parse(JSON.stringify(handoff)))).not.toThrow()
  return handoff
}

describe('routing a draft with an unproven step', () => {
  it('an unproven step with no mechanics routes to stop as indefinitive-failure', () => {
    const handoff = handoffWith(member(), block('unverified'))
    expect(stepUnproven(handoff.tests[0].steps[1])).toBe(true)

    expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('indefinitive-failure')
    const route = routeRepairOrStop(DRAFT_REF, handoff)
    expect(route.kind).toBe('stop')
    if (route.kind !== 'stop') return
    expect(route.signalClass).toBe('indefinitive-failure')
    expect(route.failurePoint?.stepIndex).toBe(1)
    expect(route.failurePoint?.reasoning).toBe(UNVERIFIED_REASON)
  })

  it('an unproven step beats a verdictSource on the same step', () => {
    const handoff = handoffWith(
      member({ verdictSourceSteps: [{ stepIndex: 1, source: 'verifier-model' }] }),
      block('inconclusive'),
    )
    expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('indefinitive-failure')
    expect(routeRepairOrStop(DRAFT_REF, handoff).kind).toBe('stop')
  })

  it('an unproven step is never repaired because another step carries a mechanics signal', () => {
    const handoff = handoffWith(member({ planningFailureSteps: [0] }), block('unverified'))
    expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('indefinitive-failure')
    const route = routeRepairOrStop(DRAFT_REF, handoff)
    expect(route.kind).toBe('stop')
    if (route.kind !== 'stop') return
    expect(route.failurePoint?.stepIndex).toBe(1)
  })

  it("a not-met block with a verdictSource keeps today's clean-definitive-assertion-fail", () => {
    const handoff = handoffWith(
      member({ verdictSourceSteps: [{ stepIndex: 1, source: 'verifier-model' }] }),
      block('not-met'),
    )
    expect(stepUnproven(handoff.tests[0].steps[1])).toBe(false)
    expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('clean-definitive-assertion-fail')
    const route = routeRepairOrStop(DRAFT_REF, handoff)
    expect(route.kind).toBe('stop')
    if (route.kind !== 'stop') return
    expect(route.signalClass).toBe('clean-definitive-assertion-fail')
  })

  it('an infeasible step with unverified conditions keeps routing to repair by its termination', () => {
    const handoff = handoffWith(member({ infeasibleSteps: [1] }), block('unverified', 'infeasible'))
    expect(stepUnproven(handoff.tests[0].steps[1])).toBe(true)
    expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('execution-mechanics')
    const route = routeRepairOrStop(DRAFT_REF, handoff)
    expect(route.kind).toBe('repair')
  })

  it('a member timeout whose step block ended in timeout keeps its mechanics route', () => {
    const handoff = handoffWith(member({ outcome: 'timeout' }), block('unverified', 'timeout'))
    expect(stepUnproven(handoff.tests[0].steps[1])).toBe(false)
    expect(classifyFailureEvidence(DRAFT_REF, handoff)).toBe('execution-mechanics')
    expect(routeRepairOrStop(DRAFT_REF, handoff).kind).toBe('repair')
  })

  it('a limit-stopped step still takes rule 1b', () => {
    const fixture = member({
      failedSteps: [],
      limitStopSteps: [{ stepIndex: 0, limit: 'actions', configured: 30, used: 30 }],
    })
    const handoff = handoffWith(fixture, block('unverified'))
    const route = routeRepairOrStop(DRAFT_REF, handoff)
    expect(route.kind).toBe('stop')
    if (route.kind !== 'stop') return
    expect(route.signalClass).toBe('indefinitive-failure')
    expect(route.failurePoint?.stepIndex).toBe(0)
    expect(route.failurePoint?.reasoning).toBe(handoff.tests[0].steps[0].limitStop?.reason)
  })
})
