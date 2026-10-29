// Evidence is built as schema DTOs, and the legacy trace is projected from it.
import { describe, it, expect } from 'vitest'
import {
  asRecordId,
  asRef,
  computeBriefDigest,
  guardLosslessServedBrief,
  NO_KNOWLEDGE_READER_TRUNCATION,
  sha256hex,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  Action,
  ArtifactRef,
  Decision,
  RecordedRetrievalRung,
  ScopeKey,
  ServedAdmissionEvent,
  ServedPromptTurn,
  SubActionEvidence,
  VerifierVerdict,
} from '@vostride/agent-qa-schema'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import type { Action as PlatformAction, ActionResult as PlatformActionResult } from '../../platform.js'
import {
  EvidenceRecorder,
  collapseAnnotation,
  foldCacheStatus,
  makeEmptyServedBrief,
  projectLegacyTrace,
} from '../evidence.js'
import { executeStep } from '../index.js'
import { makeAdapter, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'
import { emptyTrace } from './fixtures/served-trace.js'

// Schema Action (branded Ref) for the stored §A8 evidence; the runner-platform Action
// (plain-string ref) for collapseAnnotation, which consumes the adapter's legacy shape.
const clickAction: Action = { type: 'click', ref: asRef('e2') }
const clickPlatform: PlatformAction = { type: 'click', ref: asRef('e2') }
const passVerdict: VerifierVerdict = { pass: true, reasoning: 'goal met' }

describe('EvidenceRecorder.recordSubAction', () => {
  it('stores stateBefore as the FULL ScreenState with elements and refMap intact', () => {
    const recorder = new EvidenceRecorder()
    const stateBefore = makeScreenState()
    recorder.recordSubAction({
      plan: 'click the login button',
      plannedAction: clickAction,
      stateBefore,
      result: { success: true },
    })

    const step = recorder.finalize(passVerdict, 0, 'log in')
    const stored = step.subActions[0].stateBefore

    expect(stored.elements.length).toBeGreaterThan(0)
    expect(Object.keys(stored.refMap).length).toBeGreaterThan(0)
    expect(stored.elements).toEqual(stateBefore.elements)
    expect(stored.refMap).toEqual(stateBefore.refMap)
  })

  it('passes result through toRecordedActionResult — no screenshot bytes are stored', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'tap submit',
      plannedAction: clickAction,
      stateBefore: makeScreenState(),
      result: { success: true, screenshot: new Uint8Array([1, 2, 3, 4]), data: { ok: true } },
    })

    const step = recorder.finalize(passVerdict, 0, 'submit')
    const stored = step.subActions[0].result

    expect('screenshot' in stored).toBe(false)
    expect(stored.success).toBe(true)
    expect(stored.data).toEqual({ ok: true })
  })
})

describe('EvidenceRecorder.recordSubAction — artifact references', () => {
  const decisionRef: ArtifactRef = { id: 'decision-screenshot:abc', sha: 'a'.repeat(64) }
  const auxRefs: ArtifactRef[] = [
    { id: 'aux:1', sha: 'b'.repeat(64) },
    { id: 'aux:2', sha: 'c'.repeat(64) },
  ]

  it('copies a supplied decisionScreenshotRef byte-for-byte into the recorded evidence', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'click',
      plannedAction: clickAction,
      stateBefore: makeScreenState(),
      result: { success: true },
      decisionScreenshotRef: decisionRef,
    })
    const step = recorder.finalize(passVerdict, 0, 'click')
    expect(step.subActions[0].decisionScreenshotRef).toEqual(decisionRef)
  })

  it('preserves supplied auxiliary artifactRefs order and identity', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'click',
      plannedAction: clickAction,
      stateBefore: makeScreenState(),
      result: { success: true },
      artifactRefs: auxRefs,
    })
    const step = recorder.finalize(passVerdict, 0, 'click')
    expect(step.subActions[0].artifactRefs).toEqual(auxRefs)
    // shallow copy — a mutation of the stored array must not alias the input
    expect(step.subActions[0].artifactRefs).not.toBe(auxRefs)
  })

  it('leaves both artifact fields structurally absent when not supplied', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'click',
      plannedAction: clickAction,
      stateBefore: makeScreenState(),
      result: { success: true },
    })
    const step = recorder.finalize(passVerdict, 0, 'click')
    expect('decisionScreenshotRef' in step.subActions[0]).toBe(false)
    expect('artifactRefs' in step.subActions[0]).toBe(false)
  })

  it('records the ArtifactRef while the inline result screenshot bytes stay excluded', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'tap submit',
      plannedAction: clickAction,
      stateBefore: makeScreenState(),
      result: { success: true, screenshot: new Uint8Array([9, 9, 9]) },
      decisionScreenshotRef: decisionRef,
    })
    const step = recorder.finalize(passVerdict, 0, 'submit')
    expect('screenshot' in step.subActions[0].result).toBe(false)
    expect(step.subActions[0].decisionScreenshotRef).toEqual(decisionRef)
  })

  it('emits the artifact-bearing evidence through onSubActionRecorded', () => {
    const observed: SubActionEvidence[] = []
    const recorder = new EvidenceRecorder({
      onSubActionRecorded: (evidence) => observed.push(evidence),
    })
    recorder.recordSubAction({
      plan: 'click',
      plannedAction: clickAction,
      stateBefore: makeScreenState(),
      result: { success: true },
      decisionScreenshotRef: decisionRef,
      artifactRefs: auxRefs,
    })
    expect(observed).toHaveLength(1)
    expect(observed[0].decisionScreenshotRef).toEqual(decisionRef)
    expect(observed[0].artifactRefs).toEqual(auxRefs)
  })
})

describe('makeEmptyServedBrief', () => {
  it('returns a self-consistent digest over empty channels', () => {
    const scope: ScopeKey = { tier: 'test', key: 'checkout' }
    const brief = makeEmptyServedBrief(scope, 42)

    expect(brief.channel1).toEqual([])
    expect(brief.channel2).toEqual([])
    expect(brief.channel3).toEqual([])
    expect(brief.budget).toBe(0)
    expect(brief.truncation).toContain('no brief served')
    expect(brief.briefDigest).toBe(computeBriefDigest(brief))
  })

  // One shared constant: `runs.knowledge` reads the same marker, so a second literal could drift.
  it('marks the empty brief with the schema-owned NO_KNOWLEDGE_READER_TRUNCATION constant', () => {
    const brief = makeEmptyServedBrief({ tier: 'test', key: 'checkout' }, 42)
    expect(brief.truncation).toBe(NO_KNOWLEDGE_READER_TRUNCATION)
  })
})

// The rung sits beside `retrievalTrace`, never in `servedBrief`, so the brief's digest is stable.
describe('EvidenceRecorder retrievalRung stamping', () => {
  const rung: RecordedRetrievalRung = {
    schemaVersion: 2,
    rung: 'static-floor',
    reason: 'native-runtime-unavailable',
  }

  it('stamps the handed rung onto finalized evidence, verbatim', () => {
    const recorder = new EvidenceRecorder({ retrievalRung: rung })
    const evidence = recorder.finalize(passVerdict, 0, 'log in')
    expect(evidence.retrievalRung).toEqual(rung)
  })

  it('omits the key entirely when no rung was handed — never a zero-fill', () => {
    const evidence = new EvidenceRecorder().finalize(passVerdict, 0, 'log in')
    expect('retrievalRung' in evidence).toBe(false)
  })

  it('leaves servedBrief bytes untouched — the rung never enters the brief digest', () => {
    const withRung = new EvidenceRecorder({ retrievalRung: rung }).finalize(passVerdict, 0, 'log in')
    const without = new EvidenceRecorder().finalize(passVerdict, 0, 'log in')
    expect(withRung.servedBrief.briefDigest).toBe(without.servedBrief.briefDigest)
  })
})

function servedAdmissionEvent(
  overrides: Partial<ServedAdmissionEvent> = {},
): ServedAdmissionEvent {
  return {
    ordinal: 0,
    turnOrdinal: 0,
    surface: 'brief-line',
    id: asRecordId('record-checkout'),
    sourceId: 'record-checkout',
    clusterKey: '/checkout',
    renderedCost: 12,
    chargeRepeated: false,
    ...overrides,
  }
}

function servedPromptTurn(
  overrides: Partial<ServedPromptTurn> = {},
): ServedPromptTurn {
  const policyL0 = overrides.policyL0 ?? 'Treat checkout policy as authoritative.'
  const contextTier = overrides.contextTier ?? 'Current test: checkout\nCurrent step: pay'
  const volatileTier = overrides.volatileTier ?? 'Current date: 2026-07-24'
  return {
    ordinal: 0,
    turnOrdinal: 0,
    runDate: '2026-07-24',
    policyL0,
    learnedL1: '',
    learnedL2: '',
    contextTier,
    volatileTier,
    policyDigest: sha256hex(policyL0),
    contextTierDigest: sha256hex(contextTier),
    volatileTierDigest: sha256hex(volatileTier),
    ...overrides,
  }
}

describe('EvidenceRecorder — lossless ServedBrief proof', () => {
  it('begins with exact production caps and empty ordered histories', () => {
    const recorder = new EvidenceRecorder()

    recorder.beginLosslessServedBrief({ recordCap: 8, combinedBudget: 576 })
    const brief = recorder.finalize(passVerdict, 0, 'checkout').servedBrief

    expect(brief.proof).toEqual({
      schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
      completeness: 'lossless',
      recordCap: 8,
      combinedBudget: 576,
      admissionEvents: [],
      promptTurns: [],
    })
    expect(brief.briefDigest).toBe(computeBriefDigest(brief))
  })

  it('clones contiguous event and prompt appends and re-addresses every mutation', () => {
    const recorder = new EvidenceRecorder()
    const events = [
      servedAdmissionEvent(),
      servedAdmissionEvent({
        ordinal: 1,
        surface: 'search-result',
        id: asRecordId('record-search'),
        sourceId: 'record-search',
      }),
    ]
    const firstTurn = servedPromptTurn()

    recorder.beginLosslessServedBrief({ recordCap: 8, combinedBudget: 576 })
    const emptyDigest = recorder.finalize(passVerdict, 0, 'checkout').servedBrief.briefDigest
    recorder.recordServedAdmissionEvents(events)
    const eventDigest = recorder.finalize(passVerdict, 0, 'checkout').servedBrief.briefDigest
    recorder.recordServedPromptTurn(firstTurn)
    const promptDigest = recorder.finalize(passVerdict, 0, 'checkout').servedBrief.briefDigest

    events[0].sourceId = 'mutated-after-append'
    firstTurn.contextTier = 'mutated-after-append'
    const brief = recorder.finalize(passVerdict, 0, 'checkout').servedBrief
    expect(brief.proof?.admissionEvents[0].sourceId).toBe('record-checkout')
    expect(brief.proof?.promptTurns[0].contextTier).toBe(
      'Current test: checkout\nCurrent step: pay',
    )
    expect(brief.proof?.admissionEvents).not.toBe(events)
    expect(brief.proof?.promptTurns[0]).not.toBe(firstTurn)
    expect(new Set([emptyDigest, eventDigest, promptDigest]).size).toBe(3)
    expect(brief.briefDigest).toBe(computeBriefDigest(brief))
  })

  it('rejects discontinuous event and prompt ordinals without mutating proof history', () => {
    const recorder = new EvidenceRecorder()
    recorder.beginLosslessServedBrief({ recordCap: 8, combinedBudget: 576 })

    expect(() => recorder.recordServedAdmissionEvents([
      servedAdmissionEvent({ ordinal: 1 }),
    ])).toThrow(/admission event ordinal/i)
    expect(() => recorder.recordServedPromptTurn(
      servedPromptTurn({ ordinal: 1 }),
    )).toThrow(/prompt turn ordinal/i)

    const brief = recorder.finalize(passVerdict, 0, 'checkout').servedBrief
    expect(brief.proof?.admissionEvents).toEqual([])
    expect(brief.proof?.promptTurns).toEqual([])
    expect(brief.briefDigest).toBe(computeBriefDigest(brief))
  })

  it('preserves prior proof history when Channel 1 is re-read on a replan', () => {
    const recorder = new EvidenceRecorder()
    const event = servedAdmissionEvent()
    const turn = servedPromptTurn()
    recorder.beginLosslessServedBrief({ recordCap: 8, combinedBudget: 576 })
    recorder.recordServedAdmissionEvents([event])
    recorder.recordServedPromptTurn(turn)

    recorder.recordServedBrief({
      scope: { tier: 'test', key: 'checkout' },
      asOfBuild: 42,
      budget: 100,
      block: {
        tiers: { L0: 'policy', L1: 'learned', L2: '' },
        lines: [{
          id: event.id,
          kind: 'fact',
          summary: 'Checkout requires confirmation.',
          trust: 0.9,
          status: 'active',
          servedAsCanary: false,
          tier: 'L1',
        }],
        truncation: 'none',
        admissions: [],
      },
      trace: emptyTrace(),
    })

    const brief = recorder.finalize(passVerdict, 0, 'checkout').servedBrief
    expect(brief.proof?.admissionEvents).toEqual([event])
    expect(brief.proof?.promptTurns).toEqual([turn])
    expect(guardLosslessServedBrief(brief)).toEqual(brief)
  })

  it('finalizes reader-backed and no-reader records as guard-valid after a real prompt turn', () => {
    const readerBacked = new EvidenceRecorder()
    readerBacked.beginLosslessServedBrief({ recordCap: 8, combinedBudget: 576 })
    readerBacked.recordServedBrief({
      scope: { tier: 'test', key: 'checkout' },
      asOfBuild: 42,
      budget: 100,
      block: {
        tiers: { L0: 'policy', L1: '', L2: '' },
        lines: [],
        truncation: 'none',
        admissions: [],
      },
      trace: emptyTrace(),
    })
    readerBacked.recordServedPromptTurn(servedPromptTurn())

    const noReader = new EvidenceRecorder({
      scope: { tier: 'test', key: 'checkout' },
      asOfBuild: 42,
    })
    noReader.beginLosslessServedBrief({ recordCap: 8, combinedBudget: 576 })
    noReader.recordServedPromptTurn(servedPromptTurn())

    for (const recorder of [readerBacked, noReader]) {
      const brief = recorder.finalize(passVerdict, 0, 'checkout').servedBrief
      expect(guardLosslessServedBrief(brief)).toEqual(brief)
    }
  })
})

describe('foldCacheStatus', () => {
  it('all-hit ⇒ hit', () => {
    expect(foldCacheStatus([true, true, true])).toBe('hit')
  })

  it('any-miss ⇒ miss', () => {
    expect(foldCacheStatus([true, false, true])).toBe('miss')
  })

  it('empty step ⇒ miss', () => {
    expect(foldCacheStatus([])).toBe('miss')
  })
})

describe('projectLegacyTrace', () => {
  it('produces the v1 string-shaped trace from a populated StepEvidence (tree round-trips)', () => {
    const recorder = new EvidenceRecorder()
    const before = makeScreenState()
    const after = makeScreenState({ url: 'https://example.test/after' })
    const idx = recorder.recordSubAction({
      plan: 'click the login button',
      plannedAction: clickAction,
      stateBefore: before,
      result: { success: true, data: 'v' },
      cached: true,
    })
    recorder.attachStateAfter(idx, after)

    const step = recorder.finalize(passVerdict, 0, 'log in')
    const trace = projectLegacyTrace(step)

    expect(trace).toHaveLength(1)
    expect(trace[0].index).toBe(0)
    expect(trace[0].screenStateBefore).toBe(before.tree)
    expect(trace[0].observation).toBe(before.tree)
    expect(trace[0].screenStateAfter).toBe(after.tree)
    expect(trace[0].result).toBe('success')
    expect(trace[0].reasoning).toBe('click the login button')
    expect(trace[0].plannedAction).toEqual(clickAction)
    expect(trace[0].data).toBe('v')
    // richer→poorer: the legacy trace is strings only, never the full ScreenState.
    expect(typeof trace[0].screenStateBefore).toBe('string')
  })

  it('projects a collapsed annotation onto the legacy StepAnnotation', () => {
    const recorder = new EvidenceRecorder()
    const exec: PlatformActionResult = { success: true, coordinates: { x: 40, y: 50 }, boundingBox: { x: 10, y: 20, width: 60, height: 30 } }
    const annotation = collapseAnnotation(clickPlatform, exec, { width: 390, height: 844 })
    recorder.recordSubAction({
      plan: 'click',
      plannedAction: clickAction,
      stateBefore: makeScreenState(),
      result: { success: true, annotation },
    })

    const step = recorder.finalize(passVerdict, 0, 'click')
    const trace = projectLegacyTrace(step)

    expect(trace[0].annotation?.type).toBe('click')
    expect(trace[0].annotation?.clickPoint).toEqual({ x: 40, y: 50 })
    expect(trace[0].annotation?.boundingBox).toEqual({ x: 10, y: 20, width: 60, height: 30 })
  })
})

// A skipped tap is its own sub-action outcome, never `failure`.
describe('skipped taps in the legacy trace', () => {
  const skippedTap: PlatformActionResult = {
    success: false,
    metadata: { idempotentNoop: { currentState: 'checked', inputSent: false } },
  }

  function traceOf(result: PlatformActionResult) {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'turn Wi-Fi on',
      plannedAction: { type: 'tap', ref: asRef('e3') },
      stateBefore: makeScreenState(),
      result,
    })
    return projectLegacyTrace(recorder.finalize(passVerdict, 0, 'turn Wi-Fi on'))[0]!
  }

  it('the legacy trace marks a skipped tap', () => {
    const trace = traceOf(skippedTap)
    expect(trace.result).toBe('no-input')
    expect(trace.noInputSent).toEqual({ currentState: 'checked' })
    expect('error' in trace).toBe(false)
  })

  it('the legacy trace marks the same skipped tap planned twice no-input both times', () => {
    const recorder = new EvidenceRecorder()
    for (let i = 0; i < 2; i++) {
      recorder.recordSubAction({
        plan: 'turn Wi-Fi on',
        plannedAction: { type: 'tap', ref: asRef('e3') },
        stateBefore: makeScreenState(),
        result: skippedTap,
      })
    }
    const trace = projectLegacyTrace(recorder.finalize(passVerdict, 0, 'turn Wi-Fi on'))
    expect(trace.map((sub) => sub.result)).toEqual(['no-input', 'no-input'])
    expect(trace.some((sub) => 'error' in sub)).toBe(false)
  })

  it('a cancelled step keeps its skipped tap no-input in the legacy trace', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'turn Wi-Fi on',
      plannedAction: { type: 'tap', ref: asRef('e3') },
      stateBefore: makeScreenState(),
      result: skippedTap,
    })
    const cancelled: VerifierVerdict = { pass: false, reasoning: 'The run was cancelled before this step finished.' }
    const [trace] = projectLegacyTrace(recorder.finalize(cancelled, 0, 'turn Wi-Fi on'))
    expect(trace!.result).toBe('no-input')
    expect('error' in trace!).toBe(false)
  })

  it('an ordinary success and an ordinary failure project exactly as before', () => {
    const passed = traceOf({ success: true })
    expect(passed.result).toBe('success')
    expect('noInputSent' in passed).toBe(false)
    expect('error' in passed).toBe(false)
    const failed = traceOf({ success: false, error: 'element not found' })
    expect(failed.result).toBe('failure')
    expect(failed.error).toBe('element not found')
    expect('noInputSent' in failed).toBe(false)
  })
})

describe('EvidenceRecorder.recordSelfHeal', () => {
  it('stores the {failedDecision, recoveringDecision} pair on the finalized StepEvidence', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordSubAction({
      plan: 'click wrong element',
      plannedAction: clickAction,
      stateBefore: makeScreenState(),
      result: { success: false, error: 'element not found' },
    })

    const failedDecision: Decision = {
      plan: 'click wrong element',
      plannedAction: clickAction,
      result: { success: false, error: 'element not found' },
    }
    const recoveringDecision: Decision = {
      plan: 'click the correct element',
      plannedAction: { type: 'click', ref: asRef('e1') },
      result: { success: true },
    }
    recorder.recordSelfHeal(failedDecision, recoveringDecision)

    const step = recorder.finalize({ pass: true, reasoning: 'recovered' }, 1, 'log in')

    expect(step.selfHeal).toBeDefined()
    expect(step.selfHeal?.failedDecision).toEqual(failedDecision)
    expect(step.selfHeal?.recoveringDecision).toEqual(recoveringDecision)
  })
})

describe('collapseAnnotation', () => {
  it('maps a click execResult onto the schema point annotation', () => {
    const exec: PlatformActionResult = { success: true, coordinates: { x: 40, y: 50 } }
    const annotation = collapseAnnotation(clickPlatform, exec, { width: 390, height: 844 })
    expect(annotation.kind).toBe('point')
    if (annotation.kind === 'point') {
      expect(annotation.point.x).toBe(40)
      expect(annotation.point.y).toBe(50)
    }
  })

  it('maps a swipe execResult onto the schema path annotation', () => {
    const swipe: PlatformAction = { type: 'swipe', mode: 'direction', direction: 'up', durationMs: 300 }
    const exec: PlatformActionResult = { success: true, startCoordinates: { x: 10, y: 200 }, endCoordinates: { x: 10, y: 40 } }
    const annotation = collapseAnnotation(swipe, exec, { width: 390, height: 844 })
    expect(annotation.kind).toBe('path')
    if (annotation.kind === 'path') {
      expect(annotation.path.start).toEqual({ x: 10, y: 200 })
      expect(annotation.path.end).toEqual({ x: 10, y: 40 })
    }
    expect(annotation.direction).toBe('up')
  })
})

describe('EvidenceRecorder.finalize — interpolatedVariables stamp', () => {
  const pairs = [
    { name: 'PROBE_USER', value: 'qa.user@example.com' },
    { name: 'PROBE_ORDER', value: 'ORD-123' },
  ]

  it('stamps the supplied pairs verbatim onto the finalized StepEvidence', () => {
    const recorder = new EvidenceRecorder()
    const step = recorder.finalize(passVerdict, 0, 'log in as qa.user@example.com', {
      interpolatedVariables: pairs,
    })
    expect(step.interpolatedVariables).toEqual(pairs)
  })

  it('leaves the field structurally ABSENT when the loop supplied nothing', () => {
    const recorder = new EvidenceRecorder()
    const step = recorder.finalize(passVerdict, 0, 'log in')
    expect('interpolatedVariables' in step).toBe(false)
  })

  it('leaves the field structurally ABSENT for an empty list (base fixture unchanged)', () => {
    const recorder = new EvidenceRecorder()
    const step = recorder.finalize(passVerdict, 0, 'log in', { interpolatedVariables: [] })
    expect('interpolatedVariables' in step).toBe(false)
  })

  it('copies the list — a later mutation of the input never aliases the evidence', () => {
    const recorder = new EvidenceRecorder()
    const input = [{ name: 'PROBE_USER', value: 'qa.user@example.com' }]
    const step = recorder.finalize(passVerdict, 0, 'log in', { interpolatedVariables: input })
    expect(step.interpolatedVariables).not.toBe(input)
    expect(step.interpolatedVariables).toEqual(input)
  })
})

// Masking the provenance values would break the emit fold's exact match with `plannedAction`.
describe('executeStep — provenance pairs are never masked', () => {
  // A redactor that transforms every string, so any provenance value routed through it shows.
  const transformingRedactor = { redactString: (text: string) => `MASKED(${text})` }

  async function stampedPairs(
    interpolatedVariables: { name: string; value: string }[],
  ): Promise<unknown> {
    const result = await executeStep(
      'log in',
      { adapter: makeAdapter(), planner: makePlanner(), verifier: makeVerifier(), secretRedactor: transformingRedactor } as never,
      makeStepContext({ interpolatedVariables }),
    )
    return (result.evidence as { interpolatedVariables?: unknown } | undefined)
      ?.interpolatedVariables
  }

  it('an EMAIL-valued binding survives byte-identically through a transforming masking port', async () => {
    const pair = { name: 'PROBE_USER', value: 'qa.user@example.com' }
    expect(await stampedPairs([pair])).toEqual([pair])
  })

  it('a CREDENTIAL-NAMED binding survives byte-identically through a transforming masking port', async () => {
    const pair = { name: 'PROBE_API_TOKEN', value: 'tok-live-9f3a2b' }
    expect(await stampedPairs([pair])).toEqual([pair])
  })
})
