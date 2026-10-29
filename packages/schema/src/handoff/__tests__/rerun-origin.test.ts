import { describe, expect, it } from 'vitest'
import { guardCompletedRunHandoff } from '../load-completed-run-handoff'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '../completed-run-handoff'
import { canonicalJson } from '../../determinism/canonical-json'
import { sha256hex } from '../../determinism/sha256'
import { screenStateHash } from '../../determinism/screen-hash'
import { asRunId } from '../../run/run-id'

const runId = asRunId('origin fixture')
function origin() {
  const evidence = {
    stepIndex: 0, stepText: 'Open', cacheStatus: 'miss',
    servedBrief: { channel1: [] }, verifierVerdict: { pass: false, reasoning: 'failed' },
    subActions: [{ plan: 'Open', plannedAction: { type: 'navigate', to: 'url', url: 'https://example.test' },
      result: { success: false }, stateBefore: { platform: 'web', tree: '', elements: [], refMap: {},
        timestamp: 1, metadata: { captureMode: 'textOnly', coordSpace: 'css', viewportWidth: 100,
          viewportHeight: 100, scroll: { offsetX: 0, offsetY: 0, contentWidth: 100, contentHeight: 100 } } } }],
  }
  const facts = { runId, testId: 'origin member', testIndex: 0, stepIndex: 0, decisionOrdinal: 0, evidence }
  const decision = { ...facts,
    screenStateHash: screenStateHash(evidence.subActions[0].stateBefore as never),
    evidenceDigest: sha256hex(canonicalJson(facts)) }
  const factsOrigin = { attempt: 0, outcome: 'failed', decisions: [decision], rootCause: {
    class: 'unknown', producer: 'deterministic-classifier', confidence: 0,
    evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'no deterministic signal matched' },
    memoryMisdirectionRuledOut: true, perTest: 0,
  } }
  return { ...factsOrigin, evidenceDigest: sha256hex(canonicalJson(factsOrigin)) }
}

function handoff(rerunOrigin: unknown = origin()) {
  return { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId,
    scope: { tier: 'test', key: 'origin fixture' }, buildOrdinal: 1, executionContext: 'ci',
    aggregateVerdict: 'passed', configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1, endedAt: 2,
    tests: [{ testId: 'origin member', testName: 'Origin', filePath: 'origin.yaml', testIndex: 0,
      outcome: 'passed', steps: [], isRerun: true, rerunAttempt: 2, rerunOrigin }] }
}

describe('guarded rerun origin', () => {
  it('rejects unsafe original attempt numbers', () => {
    for (const attempt of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0']) {
      expect(() => guardCompletedRunHandoff(handoff({ ...origin(), attempt }))).toThrow()
    }
  })
  it('loads a valid origin and preserves historic handoff bytes without inventing evidence', () => {
    const doc = handoff()
    expect(guardCompletedRunHandoff(doc)).toEqual(doc)
    const { rerunOrigin: _origin, ...legacyTest } = doc.tests[0]
    const legacy = { ...doc, tests: [legacyTest] }
    const bytes = JSON.stringify(legacy)
    expect(JSON.stringify(guardCompletedRunHandoff(JSON.parse(bytes)))).toBe(bytes)
  })
  it('rejects final-attempt origins, missing rerun markers and foreign member or run locators', () => {
    for (const patch of [{ attempt: 2 }, { attempt: 3 }, { outcome: 'passed' }, { rerunOrigin: origin() }]) {
      expect(() => guardCompletedRunHandoff(handoff({ ...origin(), ...patch }))).toThrow()
    }
    for (const patch of [{ isRerun: undefined }, { rerunAttempt: 0 }, { rerunAttempt: Infinity }]) {
      const doc = handoff()
      Object.assign(doc.tests[0], patch)
      expect(() => guardCompletedRunHandoff(doc)).toThrow()
    }
    for (const patch of [{ runId: 'foreign' }, { testId: 'foreign' }, { testIndex: 1 },
      { stepIndex: -1 }, { decisionOrdinal: 1 }, { decisionOrdinal: 0.5 }]) {
      const value = origin()
      Object.assign(value.decisions[0], patch)
      expect(() => guardCompletedRunHandoff(handoff(value))).toThrow()
    }
  })
  it('refuses bad producers, mismatched classifications, malformed or tampered digests and recursive data', () => {
    for (const patch of [{ producer: 'analyze-run' }, { producer: 'other' }, { perTest: 1 },
      { confidence: NaN }]) {
      const value = origin()
      Object.assign(value.rootCause, patch)
      expect(() => guardCompletedRunHandoff(handoff(value))).toThrow()
    }
    for (const digest of ['', 'x'.repeat(64), 'a'.repeat(64)]) {
      expect(() => guardCompletedRunHandoff(handoff({ ...origin(), evidenceDigest: digest }))).toThrow()
      const value = origin()
      value.decisions[0].screenStateHash = digest
      expect(() => guardCompletedRunHandoff(handoff(value))).toThrow()
    }
    const value = origin()
    Object.assign(value.decisions[0].evidence, { rerunOrigin: value })
    expect(() => guardCompletedRunHandoff(handoff(value))).toThrow()
  })
  it('permits absent classification and empty decisions as explicit missing evidence', () => {
    const facts = { attempt: 0, outcome: 'failed', decisions: [] }
    const value = { ...facts, evidenceDigest: sha256hex(canonicalJson(facts)) }
    expect(guardCompletedRunHandoff(handoff(value)).tests[0]).toHaveProperty('rerunOrigin', value)
  })
})
