import { describe, expect, it } from 'vitest'

import {
  SUITE_STABILITY_POSTURES,
  assessSuiteStability,
  suiteTestRef,
} from '../suite-stability'
import type { SuiteNeighbourRow } from '../suite-stability'

const TARGET = 'tests/local-form.yaml'

function neighbour(overrides: Partial<SuiteNeighbourRow> & { testName: string }): SuiteNeighbourRow {
  return {
    filePath: TARGET,
    outcomes: ['passed', 'passed'],
    quarantined: false,
    ...overrides,
  }
}

describe('assessSuiteStability', () => {
  it('has exactly three postures, and none of them covers another', () => {
    expect([...SUITE_STABILITY_POSTURES]).toEqual(['stable', 'neighbours-flaky', 'no-history'])
  })

  it('NAMES the flipping neighbours, with their distinct outcomes', () => {
    const assessment = assessSuiteStability({
      targetFilePath: TARGET,
      neighbours: [
        neighbour({ testName: 'submits the form' }),
        neighbour({ testName: 'shows the banner', outcomes: ['passed', 'failed', 'passed'] }),
      ],
    })

    expect(assessment.posture).toBe('neighbours-flaky')
    expect(assessment.flakyNeighbours).toEqual([
      {
        filePath: TARGET,
        testName: 'shows the banner',
        ref: `${TARGET}::shows the banner`,
        reason: 'verdict-flip',
        distinctOutcomes: ['passed', 'failed'],
      },
    ])
    // The message names the app, not the draft.
    expect(assessment.message).toContain('Your app is unstable')
    expect(assessment.message).toContain(`${TARGET}::shows the banner`)
  })

  it('NAMES a quarantined neighbour even when its recorded outcomes never flip', () => {
    // Quarantining a test is what STOPS its outcomes flipping, so reading the outcomes first
    // would report the one test the ledger already says is unreliable as stable.
    const assessment = assessSuiteStability({
      targetFilePath: TARGET,
      neighbours: [
        neighbour({ testName: 'submits the form' }),
        neighbour({ testName: 'retries the upload', outcomes: ['passed'], quarantined: true }),
      ],
    })

    expect(assessment.posture).toBe('neighbours-flaky')
    expect(assessment.flakyNeighbours.map((row) => row.ref))
      .toEqual([`${TARGET}::retries the upload`])
    expect(assessment.flakyNeighbours[0]?.reason).toBe('quarantined')
  })

  it('answers `no-history` — NOT `stable` — for a target nothing has ever observed', () => {
    const assessment = assessSuiteStability({
      targetFilePath: TARGET,
      neighbours: [neighbour({ testName: 'never run', outcomes: [] })],
    })

    expect(assessment.posture).toBe('no-history')
    expect(assessment.flakyNeighbours).toEqual([])
    expect(assessment.message).toContain('No stability history')
    expect(assessment.message).toContain('not a clean bill of health')
  })

  it('answers `no-history` for a target with no existing tests at all', () => {
    const assessment = assessSuiteStability({ targetFilePath: TARGET, neighbours: [] })

    expect(assessment.posture).toBe('no-history')
  })

  it('answers `stable` only when evidence was READ and it said stable', () => {
    const assessment = assessSuiteStability({
      targetFilePath: TARGET,
      neighbours: [
        neighbour({ testName: 'submits the form' }),
        neighbour({ testName: 'shows the banner', outcomes: ['passed'] }),
      ],
    })

    expect(assessment.posture).toBe('stable')
    expect(assessment.flakyNeighbours).toEqual([])
    expect(assessment.message).toContain('stable recorded outcomes')
  })

  it('mints ONE spelling of a suite test reference — never a TST short-ID', () => {
    expect(suiteTestRef(TARGET, 'shows the banner')).toBe(`${TARGET}::shows the banner`)
    expect(suiteTestRef(TARGET, 'shows the banner')).not.toMatch(/TST-\d+/)
  })
})
