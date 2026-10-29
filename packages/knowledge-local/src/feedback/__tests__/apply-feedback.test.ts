import { describe, expect, it } from 'vitest'
import { CURRENT_HANDOFF_SCHEMA_VERSION, asRecordId, asRunId, type PerTestOutcome, type StepEvidence,
  type VerdictClass } from '@vostride/agent-qa-schema'
import { makeArtifactFixture, makeScreenStateFixture } from '../../__tests__/fixtures/bundle-fixture.js'
import { applyFeedback, assertionDrift, procedureReadOn, selectFixKind, servedIdsOn,
  triageMark, type ApplyFeedbackInput, type ServedRecordFacts } from '../apply-feedback.js'
import { floorProse } from '../floor-prose.js'

const scope = { tier: 'product', key: 'checkout' } as const
const artifact = makeArtifactFixture().ref
const runId = asRunId('2026-09-08-feedback')
const target: ServedRecordFacts = { recordId: 'served-checkout', kind: 'fact', subtype: 'selector',
  anchors: [{ t: 'page', route: '/checkout' }], scope, summary: 'Checkout completes the order',
  distilledEvidenceRef: artifact, originStage: 'run-curation' }

function step(): StepEvidence {
  return { stepIndex: 0, stepText: 'Complete checkout', cacheStatus: 'miss',
    servedBrief: { scope, asOfBuild: 1, budget: 200, truncation: '', channel1: [],
      channel2: [], channel3: [], briefDigest: 'brief' },
    subActions: [{ plan: 'Click checkout', plannedAction: { type: 'delay', ms: 1 },
      stateBefore: makeScreenStateFixture(), result: { success: true } }],
    verifierVerdict: { pass: true, reasoning: 'The order is complete.' } }
}
function member(cls?: VerdictClass): PerTestOutcome {
  return { testId: 'checkout-test', testIndex: 0, testName: 'Checkout', filePath: 'tests/checkout.yaml',
    outcome: 'passed', steps: [step()], ...(cls === undefined ? {} : { rootCause: {
      class: cls, producer: 'deterministic-classifier' as const, confidence: 1,
      evidence: { citedSteps: [], citedAnchors: [], citedArtifacts: [], rationale: 'recorded class' },
      memoryMisdirectionRuledOut: true, perTest: 0,
    } }) }
}
function input(): ApplyFeedbackInput {
  return { mark: { markId: 'mark_0123456789ab', runId, runSlug: 'feedback', testIndex: 0,
    testId: 'checkout-test', kind: 'false-fail' }, resolvedStepIndex: 0, served: [target],
    handoff: { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId, scope, buildOrdinal: 1, executionContext: 'local-interactive',
      aggregateVerdict: 'passed', configDigests: { suiteConfigDigest: '', testConfigDigest: '' },
      startedAt: 0, endedAt: 1, tests: [member()] } }
}

describe('mechanical mark triage and selection', () => {
  it.each(['flake', 'environment', 'timeout'] as const)('quarantines exactly %s', (cls) => {
    expect(triageMark(member(cls))).toEqual({ kind: 'quarantined', class: cls,
      producer: 'deterministic-classifier' })
  })
  it.each(['test_bug', 'app_bug', 'config_error', 'llm_error', 'unknown'] as const)(
    'learns from %s', (cls) => expect(triageMark(member(cls))).toEqual({ kind: 'learnable',
      rootCause: { class: cls, producer: 'deterministic-classifier' } }))
  it('learns from a clean pass with absent rootCause', () => {
    expect(triageMark(member())).toEqual({ kind: 'learnable' })
  })
  it('unions channel 1 and 3 in served order, and finds an earlier channel 2 read', () => {
    const m = member()
    m.steps[0]!.servedBrief.channel1 = ['a', 'b'].map((id) => ({ id: asRecordId(id),
      kind: 'fact', summary: id, trust: 1, status: 'active', servedAsCanary: false, tier: '1' }))
    m.steps[0]!.servedBrief.channel3 = ['b', 'c'].map((id) => ({ id: asRecordId(id), anchors: [], summary: id }))
    m.steps[0]!.servedBrief.channel2 = [{ id: asRecordId('procedure'), detailLevel: 'body', bodyDigest: 'x' }]
    m.steps.push({ ...step(), stepIndex: 1 })
    expect(servedIdsOn(m.steps[0]!)).toEqual(['a', 'b', 'c'])
    expect(procedureReadOn(m, 1)).toBe('procedure')
    expect(procedureReadOn(m, -1)).toBeUndefined()
  })
  it('uses test_bug or a failed verdict with successful recorded actions for drift', () => {
    const s = step()
    expect(assertionDrift(member('test_bug'), s)).toBe(true)
    expect(assertionDrift(member(), s)).toBe(false)
    s.verifierVerdict.pass = false
    expect(assertionDrift(member(), s)).toBe(true)
    s.subActions[0]!.result.success = false
    expect(assertionDrift(member(), s)).toBe(false)
  })
  it('orders served before procedure before drift before named absence', () => {
    const m = member('test_bug')
    const base = { kind: 'false-fail' as const, member: m, step: m.steps[0]!, stepIndex: 0 }
    expect(selectFixKind({ ...base, served: [target], procedure: target })).toEqual({ fix: 'fact', target })
    expect(selectFixKind({ ...base, kind: 'false-pass', served: [target] })).toEqual({ fix: 'caution', target })
    expect(selectFixKind({ ...base, served: [], procedure: target })).toEqual({ fix: 'procedure-hint', target })
    expect(selectFixKind({ ...base, served: [] })).toEqual({ fix: 'test-edit' })
    expect(selectFixKind({ ...base, member: member(), served: [] })).toEqual({ fix: 'none',
      checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } })
    expect(() => selectFixKind({ ...base, kind: 'confirmed-bug', served: [] })).toThrow(TypeError)
  })
})

describe('assertion drift after a skipped tap', () => {
  const skippedTap = { success: false,
    metadata: { idempotentNoop: { currentState: 'checked', inputSent: false } } }
  const base = { kind: 'false-fail' as const, stepIndex: 0, served: [] }

  it('a step whose only action was a skipped tap and whose verifier failed is assertion drift', () => {
    const m = member()
    const s = m.steps[0]!
    s.subActions[0]!.result = skippedTap
    s.verifierVerdict.pass = false
    expect(assertionDrift(m, s)).toBe(true)
    expect(selectFixKind({ ...base, member: m, step: s })).toEqual({ fix: 'test-edit' })
    expect(selectFixKind({ ...base, kind: 'false-pass', member: m, step: s }))
      .toEqual({ fix: 'test-edit' })
  })

  it('a step with a real failed action and a failed verifier is not assertion drift', () => {
    const m = member()
    const s = m.steps[0]!
    s.subActions[0]!.result = { success: false, error: 'element not found' }
    s.subActions.push({ ...s.subActions[0]!, result: skippedTap })
    s.verifierVerdict.pass = false
    expect(assertionDrift(m, s)).toBe(false)
    expect(selectFixKind({ ...base, member: m, step: s })).toEqual({ fix: 'none',
      checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } })
  })
})

describe('schema-valid floor plans', () => {
  it.each(['caution', 'unknown'] as const)('does not offer an uncommittable fact from a served %s', kind => {
    const value = input()
    const { subtype: _, ...withoutSubtype } = target
    value.served = [{ ...withoutSubtype, kind }]
    expect(applyFeedback(value)).toMatchObject({ kind: 'no-draftable-fix',
      checked: { servedRecords: 1, procedureReads: 0, assertionDrift: false } })
    value.mark.kind = 'false-pass'
    expect(applyFeedback(value)).toMatchObject({ kind: 'knowledge', fix: 'caution' })
  })
  it('supersedes exactly the cited fact with user origin and recorded screenshot', () => {
    const value = input()
    const screenshot = { ...artifact, id: 'decision' }
    value.handoff.tests[0]!.steps[0]!.subActions[0]!.decisionScreenshotRef = screenshot
    value.mark.note = '<script>producer text</script>'
    const plan = applyFeedback(value)
    expect(plan.kind).toBe('knowledge')
    if (plan.kind !== 'knowledge') throw new Error('expected knowledge')
    expect(plan.deltas).toHaveLength(1)
    expect(plan.deltas[0]).toMatchObject({ kind: 'Supersede', origin: 'user', citedIds: [target.recordId],
      victimId: target.recordId, newBundle: { distilledEvidenceRef: screenshot, originStage: 'run-curation' } })
    // Producer text remains verbatim: masking belongs to renderers, never structural drafting.
    expect(JSON.stringify(plan)).toContain('User note: <script>producer text</script>')
    expect(plan.wording).toBe('floor')
  })
  it('constructs every remaining arm and never MintUnknown', () => {
    const caution = input(); caution.mark.kind = 'false-pass'
    const procedure = input(); procedure.served = []; procedure.procedure = { ...target, kind: 'procedure' }
    const drift = input(); drift.served = []; drift.handoff.tests = [member('test_bug')]
    const empty = input(); empty.served = []
    const plans = [input(), caution, procedure, drift, empty].map(applyFeedback)
    expect(plans[1]).toMatchObject({ kind: 'knowledge', fix: 'caution', deltas: [{ kind: 'Add', bundle: { kind: 'caution' } }] })
    expect(plans[2]).toMatchObject({ kind: 'knowledge', fix: 'procedure-hint', deltas: [{ kind: 'Add', bundle: { kind: 'fact', subtype: 'navigational' } }] })
    expect(plans[3]).toMatchObject({ kind: 'test-edit', testRef: 'tests/checkout.yaml::Checkout', intent: expect.any(String) })
    expect(plans[4]).toMatchObject({ kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } })
    for (const plan of plans) expect(JSON.stringify(plan)).not.toContain('MintUnknown')
    drift.testRef = 'explicit.yaml::Test'
    expect(applyFeedback(drift)).toMatchObject({ testRef: drift.testRef })
    delete drift.testRef; drift.handoff.tests[0]!.filePath = ''
    expect(applyFeedback(drift)).toMatchObject({ kind: 'no-draftable-fix', checked: { assertionDrift: true } })
  })
  it('refuses quarantine, confirmed-bug, mismatched run and absent steps', () => {
    const value = input(); value.handoff.tests = [member('flake')]
    expect(() => applyFeedback(value)).toThrow('quarantined')
    value.handoff.tests = [member()]; value.mark.kind = 'confirmed-bug'
    expect(() => applyFeedback(value)).toThrow('confirmed-bug')
    value.mark.kind = 'false-fail'; value.resolvedStepIndex = 2
    expect(() => applyFeedback(value)).toThrow('step')
    value.handoff.runId = asRunId('another-run')
    expect(() => applyFeedback(value)).toThrow('handoff')
  })
  it('bounds prose including a large final user note, deterministically', () => {
    const value = { kind: 'false-fail' as const, fix: 'fact' as const,
      stepText: 'long step '.repeat(100), verifierReasoning: 'long reason '.repeat(200), note: 'note '.repeat(600) }
    const prose = floorProse(value)
    expect(prose.summary.length).toBeLessThanOrEqual(160)
    expect(prose.body.length).toBeLessThanOrEqual(1200)
    expect(prose.body).toContain('\nUser note: ')
    expect(prose.summary).toMatch(/…$/)
    expect(floorProse(value)).toEqual(prose)
  })
})
