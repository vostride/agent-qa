// D-29/D-17: a handoff written by the unchanged producer at agent-qa
// 5e3e932a2d586f89c805a385483da1800b941fff still reads, and its digests still recompute.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  guardCompletedRunHandoff,
  projectSubActionRecorded,
  screenStateHash,
  sha256hex,
} from '../index'
import type { CompletedRunHandoff } from '../index'

const fixtureDir = new URL('../../../../test-fixtures/legacy-handoff/', import.meta.url)
const handoffBytes = readFileSync(new URL('handoff.json', fixtureDir))
const manifest = JSON.parse(readFileSync(new URL('MANIFEST.json', fixtureDir), 'utf8')) as {
  frozen: boolean
  source: { agentQaSha: string; generator: string }
  files: { path: string; sha256: string; bytes: number }[]
  pins: {
    decisions: {
      testIndex: number
      stepIndex: number
      decisionOrdinal: number
      screenStateHash: string
      evidenceDigest: string
    }[]
  }
}
const handoff = JSON.parse(handoffBytes.toString('utf8')) as CompletedRunHandoff
const steps = handoff.tests.flatMap(test => test.steps)

describe('C436-PRE-CHANGE-HANDOFF', () => {
  it('the manifest names 5e3e932a2 and the fixture matches its sha-256', () => {
    expect(manifest.frozen).toBe(true)
    expect(manifest.source.agentQaSha).toBe('5e3e932a2d586f89c805a385483da1800b941fff')
    expect(manifest.source.generator).toBe(
      '.planning/phases/436-harness-action-outcomes/capture/capture-pre-change-handoff.mjs',
    )
    expect(manifest.files).toEqual([
      {
        path: 'handoff.json',
        sha256: createHash('sha256').update(handoffBytes).digest('hex'),
        bytes: handoffBytes.length,
      },
    ])
  })

  it('guardCompletedRunHandoff accepts the pre-change handoff', () => {
    const guarded = guardCompletedRunHandoff(JSON.parse(handoffBytes.toString('utf8')))
    expect(guarded.runId).toBe(handoff.runId)
    expect(guarded.tests).toHaveLength(1)
    expect(guarded.tests[0].steps).toHaveLength(3)
  })

  it('the fixture carries localEffect, stagnation and cycle blocks', () => {
    expect(steps.some(step => step.subActions.some(subAction => subAction.localEffect !== undefined)))
      .toBe(true)
    expect(steps.filter(step => step.stagnation !== undefined)).toHaveLength(1)
    expect(steps.filter(step => step.cycle !== undefined)).toHaveLength(1)
  })

  it('projectSubActionRecorded drops localEffect from every sub-action', () => {
    const identity = (value: string) => value
    let withLocalEffect = 0
    for (const test of handoff.tests) {
      for (const step of test.steps) {
        step.subActions.forEach((subAction, subActionIndex) => {
          if (subAction.localEffect !== undefined) withLocalEffect++
          const payload = projectSubActionRecorded(
            subAction,
            { testIndex: test.testIndex, stepIndex: step.stepIndex, subActionIndex },
            identity,
          )
          expect(Object.keys(payload)).not.toContain('localEffect')
          expect(payload.screenStateHash).toBe(screenStateHash(subAction.stateBefore))
        })
      }
    }
    expect(withLocalEffect).toBeGreaterThan(0)
  })

  it('screenStateHash and the decision digests recompute to the pinned values', () => {
    const recomputed = handoff.tests.flatMap(test =>
      test.steps.flatMap(step =>
        step.subActions.map((subAction, decisionOrdinal) => ({
          testIndex: test.testIndex,
          stepIndex: step.stepIndex,
          decisionOrdinal,
          screenStateHash: screenStateHash(subAction.stateBefore),
          evidenceDigest: sha256hex(canonicalJson({
            runId: handoff.runId,
            testId: test.testId,
            testIndex: test.testIndex,
            stepIndex: step.stepIndex,
            decisionOrdinal,
            evidence: step,
          })),
        })),
      ),
    )
    expect(recomputed.length).toBeGreaterThan(0)
    expect(recomputed).toEqual(manifest.pins.decisions)
  })

  it('a rerun origin carrying the pinned decision hashes still loads', () => {
    const [test] = handoff.tests
    const decisions = manifest.pins.decisions
      .filter(pin => pin.testIndex === test.testIndex)
      .map(pin => ({
        runId: handoff.runId,
        testId: test.testId,
        testIndex: test.testIndex,
        stepIndex: pin.stepIndex,
        decisionOrdinal: pin.decisionOrdinal,
        screenStateHash: pin.screenStateHash,
        evidenceDigest: pin.evidenceDigest,
        evidence: test.steps.find(step => step.stepIndex === pin.stepIndex),
      }))
    const origin = { attempt: 0, outcome: 'failed', decisions }
    const rerun = {
      ...handoff,
      tests: [
        {
          ...test,
          isRerun: true,
          rerunAttempt: 1,
          rerunOrigin: { ...origin, evidenceDigest: sha256hex(canonicalJson(origin)) },
        },
      ],
    }

    expect(decisions.length).toBeGreaterThan(0)
    expect(() => guardCompletedRunHandoff(JSON.parse(JSON.stringify(rerun)))).not.toThrow()
  })
})
