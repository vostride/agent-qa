import { CURRENT_HANDOFF_SCHEMA_VERSION, guardCompletedRunHandoff } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_ARTIFACT_SHA,
  FIXTURE_SCREENSHOT_SHA,
  makeArtifactRefV2Handoff,
  makeDegradedV2Handoff,
  makeV2Handoff,
} from './fixtures/handoff-fixtures'

describe('schemaVersion-2 handoff fixtures', () => {
  it('all variants pass the real completed-run handoff guard', () => {
    for (const handoff of [
      makeV2Handoff(),
      makeDegradedV2Handoff(),
      makeArtifactRefV2Handoff(),
    ]) {
      expect(guardCompletedRunHandoff(handoff)).toBe(handoff)
      expect(handoff.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
    }
  })

  it('pins the full selection, identity, failure, and final-assert shapes', () => {
    const handoff = makeV2Handoff()
    const passing = handoff.tests[0]!
    const mixedStep = passing.steps[1]!

    expect(Object.hasOwn(mixedStep.subActions[0]!, 'exchanges')).toBe(false)
    expect(mixedStep.subActions[1]!.exchanges).toEqual([])
    expect(passing.steps[2]!.subActions).toEqual([])

    const identityElements = passing.steps[0]!.subActions[0]!.stateBefore.elements.filter(
      (entry) => entry.role === 'button' && entry.nameNormalized === 'continue',
    )
    expect(identityElements).toHaveLength(2)
    expect(identityElements.every((entry) => entry.bounds !== undefined)).toBe(true)
    expect(identityElements.every((entry) => entry.hierarchy !== undefined)).toBe(true)

    const failing = handoff.tests[1]!
    expect(failing.steps[0]!.verifierVerdict).toEqual({
      pass: false,
      reasoning: 'Continue remained blocked after execution',
    })
    expect(failing.steps[1]!.subActions).toEqual([])
    expect(failing.steps[1]!.planningFailure?.reason).toBe('tool-loop-exhausted')
    expect(failing.steps[2]!.subActions[0]!.plannedAction.type).toBe('assertValue')
    expect(failing.steps[2]!.assertOutcome).toEqual({
      source: 'url',
      op: 'contains',
      expected: '/complete',
      actual: '/checkout',
      passed: false,
    })
  })

  it('keeps optional instrumentation absent in the degraded variant', () => {
    const degraded = makeDegradedV2Handoff()
    for (const test of degraded.tests) {
      for (const currentStep of test.steps) {
        expect(currentStep.workingMemory).toBeUndefined()
        expect(currentStep.modelProfile).toBeUndefined()
        expect(currentStep.toolSchemaDigest).toBeUndefined()
        expect(currentStep.verifierIdentity).toBeUndefined()
        expect(currentStep.planningFailure?.callRecord).toBeUndefined()
        for (const subAction of currentStep.subActions) {
          expect(subAction.callRecord).toBeUndefined()
          expect(subAction.result.annotation).toBeUndefined()
          expect(
            subAction.stateBefore.elements.every((entry) => entry.hierarchy === undefined),
          ).toBe(true)
        }
      }
    }
  })

  it('adds fixed 64-hex blob references to every live decision only', () => {
    const handoff = makeArtifactRefV2Handoff()
    const liveDecisions = handoff.tests.flatMap((test) =>
      test.steps.flatMap((currentStep) =>
        currentStep.subActions.filter((subAction) => subAction.exchanges !== undefined),
      ),
    )
    const cachedDecisions = handoff.tests.flatMap((test) =>
      test.steps.flatMap((currentStep) =>
        currentStep.subActions.filter((subAction) => subAction.exchanges === undefined),
      ),
    )

    expect(liveDecisions.length).toBeGreaterThan(0)
    for (const decision of liveDecisions) {
      expect(decision.decisionScreenshotRef?.sha).toBe(FIXTURE_SCREENSHOT_SHA)
      expect(decision.artifactRefs?.map((ref) => ref.sha)).toEqual([FIXTURE_ARTIFACT_SHA])
      expect(decision.decisionScreenshotRef?.sha).toMatch(/^[0-9a-f]{64}$/)
      expect(decision.artifactRefs?.[0]?.sha).toMatch(/^[0-9a-f]{64}$/)
    }
    for (const decision of cachedDecisions) {
      expect(decision.decisionScreenshotRef).toBeUndefined()
      expect(decision.artifactRefs).toBeUndefined()
    }
  })
})
