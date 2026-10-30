import { describe, expect, it } from 'vitest'

import type {
  Action,
  ActionAnnotation,
  ArtifactRef,
  DeclaredModelProfile,
  InterpolatedVariable,
  MaskFn,
  ModelIdentity,
  RunId,
  ScopeKey,
  StepEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import {
  asRecordId,
  asRef,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardCompletedRunHandoff,
} from '@vostride/agent-qa-schema'
import type { RunConfig, RunMemberDescriptor } from '../ports.js'
import type { TestResult } from '../../result.js'
import {
  assembleHandoff,
  assemblePerTestOutcome,
  MASKED_HANDOFF_NARRATION_FIELDS,
  skippedPerTestOutcome,
} from '../handoff-assembly.js'
import { makeEmptyServedBrief } from '../../loop/evidence.js'
import { SecretRedactor, SecretStore } from '../../loop/secrets.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { startRun } from '../shell.js'

const scope: ScopeKey = { tier: 'suite', key: 'checkout' }
const member: RunMemberDescriptor = {
  testId: 'checkout-guest-1',
  name: 'Guest checkout with promo',
  filePath: 'checkout.spec.yaml',
}
const modelProfile: DeclaredModelProfile = {
  provider: 'openai-compatible',
  modelId: 'planner-model',
  vision: true,
  maxOutputTokens: 4096,
}
const verifierIdentity: ModelIdentity = {
  provider: 'anthropic-compatible',
  modelId: 'verifier-model',
}

function resultWithoutEvidence(): TestResult {
  return {
    name: 'checkout',
    filePath: 'checkout.test.ts',
    status: 'passed',
    duration: 1,
    steps: [{ name: 'submit order', status: 'passed', duration: 1 }],
  }
}

describe('handoff assembly instrumentation parity', () => {
  it.each(['passed', 'failed'] as const)('stamps member retry evidence on %s results', outcome => {
    const assembled = assemblePerTestOutcome(member,
      { ...resultWithoutEvidence(), status: outcome, retryCount: 2 }, outcome,
      { testIndex: 0, scope, buildOrdinal: 7, mask: text => text })
    expect(JSON.parse(JSON.stringify(assembled))).toMatchObject({ isRerun: true, rerunAttempt: 2 })
  })

  it.each([0, undefined])('omits both retry keys for retryCount %s', retryCount => {
    const assembled = assemblePerTestOutcome(member,
      { ...resultWithoutEvidence(), retryCount }, 'passed',
      { testIndex: 0, scope, buildOrdinal: 7, mask: text => text })
    const serialized = JSON.parse(JSON.stringify(assembled))
    expect(serialized).not.toHaveProperty('isRerun')
    expect(serialized).not.toHaveProperty('rerunAttempt')
  })
  it('copies profile, verifier identity, and digest onto synthesized step evidence', () => {
    const outcome = assemblePerTestOutcome(member, resultWithoutEvidence(), 'passed', {
      testIndex: 0,
      scope,
      buildOrdinal: 7,
      mask: (text) => text,
      modelProfile,
      verifierIdentity,
      toolSchemaDigest: 'digest-1',
    })

    expect(outcome.steps[0].modelProfile).toBe(modelProfile)
    expect(outcome.steps[0].verifierIdentity).toBe(verifierIdentity)
    expect(outcome.steps[0].toolSchemaDigest).toBe('digest-1')
  })

  it('omits instrumentation fields cleanly when synthesis dependencies are absent', () => {
    const outcome = assemblePerTestOutcome(member, resultWithoutEvidence(), 'passed', {
      testIndex: 0,
      scope,
      buildOrdinal: 7,
      mask: (text) => text,
    })

    expect(outcome.steps[0]).not.toHaveProperty('modelProfile')
    expect(outcome.steps[0]).not.toHaveProperty('verifierIdentity')
    expect(outcome.steps[0]).not.toHaveProperty('toolSchemaDigest')
  })

  it('threads member-start evidence context through the shell synthesis call site', async () => {
    const config = {
      runId: 'run-1' as RunId,
      scope,
      executionContext: 'local-headless',
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      buildOrdinal: 7,
      members: [member],
      executor: async (_member, context) => {
        context.setEvidenceContext({ modelProfile, verifierIdentity, toolSchemaDigest: 'digest-1' })
        return resultWithoutEvidence()
      },
    } satisfies RunConfig

    const { handoff } = await startRun(config).done
    const evidence = handoff.tests[0].steps[0]

    expect(evidence.modelProfile).toBe(modelProfile)
    expect(evidence.verifierIdentity).toBe(verifierIdentity)
    expect(evidence.toolSchemaDigest).toBe('digest-1')
  })

  it('stamps assembled handoffs with the current handoff schema version', () => {
    const config = {
      runId: 'run-1' as RunId,
      scope,
      executionContext: 'local-headless',
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      buildOrdinal: 7,
      members: [],
      executor: async () => resultWithoutEvidence(),
    } satisfies RunConfig

    const handoff = assembleHandoff(config, [], 'passed', { startedAt: 1, endedAt: 2 })

    expect(handoff.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
  })

  it('persists the durable outcome-exclusion marker only when the run config opts in', () => {
    const ordinaryConfig = {
      runId: 'run-ordinary' as RunId,
      scope,
      executionContext: 'local-headless',
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      buildOrdinal: 7,
      members: [],
      executor: async () => resultWithoutEvidence(),
    } satisfies RunConfig
    const excludedConfig = {
      ...ordinaryConfig,
      runId: 'run-gate' as RunId,
      excludedFromOutcomes: true,
    } satisfies RunConfig

    const ordinary = assembleHandoff(ordinaryConfig, [], 'passed', {
      startedAt: 1,
      endedAt: 2,
    })
    const excluded = assembleHandoff(excludedConfig, [], 'passed', {
      startedAt: 1,
      endedAt: 2,
    })

    expect(ordinary).not.toHaveProperty('excludedFromOutcomes')
    expect(excluded.excludedFromOutcomes).toBe(true)
    expect(JSON.parse(JSON.stringify(excluded))).toHaveProperty('excludedFromOutcomes', true)
  })

  it('assembleHandoff copies RunConfig.plannerLimits verbatim and leaves it absent when absent', () => {
    const ordinaryConfig = {
      runId: 'run-limits' as RunId,
      scope,
      executionContext: 'local-headless',
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      buildOrdinal: 7,
      members: [],
      executor: async () => resultWithoutEvidence(),
    } satisfies RunConfig
    const plannerLimits = {
      maxActions: 30,
      maxPlanningTurns: 30,
      perTest: [{ testName: 'Bulk archive', filePath: 'tests/bulk.yaml', maxActions: 60, maxPlanningTurns: 30 }],
    }
    const limitedConfig = { ...ordinaryConfig, plannerLimits } satisfies RunConfig

    const ordinary = assembleHandoff(ordinaryConfig, [], 'passed', { startedAt: 1, endedAt: 2 })
    const limited = assembleHandoff(limitedConfig, [], 'passed', { startedAt: 1, endedAt: 2 })

    expect(ordinary).not.toHaveProperty('plannerLimits')
    expect(JSON.parse(JSON.stringify(ordinary))).not.toHaveProperty('plannerLimits')
    expect(limited.plannerLimits).toEqual(plannerLimits)
    expect(guardCompletedRunHandoff(JSON.parse(JSON.stringify(limited))).plannerLimits).toEqual(plannerLimits)
  })
})

describe('§A9 rootCause attach (presence rule)', () => {
  const environmentVerdict: Verdict = {
    class: 'environment',
    producer: 'deterministic-classifier',
    confidence: 1,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'health probe: 503 in 230ms',
    },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
  }

  it('carries a supplied verdict verbatim onto the assembled outcome', () => {
    const outcome = assemblePerTestOutcome(
      member,
      resultWithoutEvidence(),
      'failed',
      { testIndex: 0, scope, buildOrdinal: 7, mask: (text) => text },
      environmentVerdict,
    )

    expect(outcome.rootCause).toBe(environmentVerdict)
  })

  it('leaves the rootCause key ABSENT (not undefined-valued) when no verdict is supplied', () => {
    const outcome = assemblePerTestOutcome(member, resultWithoutEvidence(), 'passed', {
      testIndex: 0,
      scope,
      buildOrdinal: 7,
      mask: (text) => text,
    })

    expect('rootCause' in outcome).toBe(false)
    expect(JSON.stringify(outcome)).not.toContain('rootCause')
  })

  it('keeps the handoff top-level shape unchanged — rootCause rides tests[] only', () => {
    const config = {
      runId: 'run-1' as RunId,
      scope,
      executionContext: 'local-headless',
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      buildOrdinal: 7,
      members: [member],
      executor: async () => resultWithoutEvidence(),
    } satisfies RunConfig
    const perTest = assemblePerTestOutcome(
      member,
      resultWithoutEvidence(),
      'failed',
      { testIndex: 0, scope, buildOrdinal: 7, mask: (text) => text },
      environmentVerdict,
    )

    const handoff = assembleHandoff(config, [perTest], 'failed', { startedAt: 1, endedAt: 2 })

    expect(Object.keys(handoff).sort()).toEqual([
      'aggregateVerdict',
      'buildOrdinal',
      'configDigests',
      'endedAt',
      'executionContext',
      'runId',
      'schemaVersion',
      'scope',
      'startedAt',
      'tests',
    ])
  })
})

describe('stable test identity — filePath + human testName', () => {
  it('populates filePath and human testName from the descriptor on assembled outcomes', () => {
    const outcome = assemblePerTestOutcome(member, resultWithoutEvidence(), 'passed', {
      testIndex: 0,
      scope,
      buildOrdinal: 7,
      mask: (text) => text,
    })

    expect(outcome.filePath).toBe('checkout.spec.yaml')
    expect(outcome.testName).toBe('Guest checkout with promo')
    expect(outcome.testName).not.toBe(outcome.testId)
  })

  it('populates filePath and human testName from the descriptor on skipped outcomes', () => {
    const skipped = skippedPerTestOutcome(member, 3)

    expect(skipped.filePath).toBe('checkout.spec.yaml')
    expect(skipped.testName).toBe('Guest checkout with promo')
    expect(skipped.testName).not.toBe(skipped.testId)
    expect(skipped.outcome).toBe('skipped')
  })
})

describe('StepEvidence.planSource marker', () => {
  const procedureId = asRecordId('procedure-flow-login-0123456789abcdef')

  function evidenceWith(planSource: NonNullable<StepEvidence['planSource']>): StepEvidence {
    return {
      stepIndex: 0,
      stepText: 'log in',
      cacheStatus: 'miss',
      servedBrief: makeEmptyServedBrief(scope, 7),
      subActions: [],
      verifierVerdict: { pass: true, reasoning: 'ok' },
      planSource,
    }
  }

  it('both variants typecheck and survive a handoff JSON round-trip through the one guard', () => {
    const replayStep = evidenceWith({
      kind: 'procedure-replay',
      procedureId,
      guard: { checksPassed: 3, total: 3 },
    })
    const hintStep = evidenceWith({ kind: 'procedure-hint', procedureId })
    const config = {
      runId: 'run-1' as RunId,
      scope,
      executionContext: 'local-headless',
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      buildOrdinal: 7,
      members: [member],
      executor: async () => resultWithoutEvidence(),
    } satisfies RunConfig
    const perTest = {
      testId: 'checkout-guest-1',
      testName: 'Guest checkout with promo',
      testIndex: 0,
      filePath: 'checkout.spec.yaml',
      outcome: 'passed' as const,
      steps: [replayStep, hintStep],
    }

    const handoff = assembleHandoff(config, [perTest], 'passed', { startedAt: 1, endedAt: 2 })
    const reloaded = guardCompletedRunHandoff(JSON.parse(JSON.stringify(handoff)))

    expect(reloaded.tests[0].steps[0].planSource).toEqual({
      kind: 'procedure-replay',
      procedureId,
      guard: { checksPassed: 3, total: 3 },
    })
    expect(reloaded.tests[0].steps[1].planSource).toEqual({ kind: 'procedure-hint', procedureId })
    // planSource never touches the cached-provenance surface.
    expect(reloaded.tests[0].steps[0].cacheStatus).toBe('miss')
  })

  it('records a guard miss on the replay variant', () => {
    const step = evidenceWith({
      kind: 'procedure-replay',
      procedureId,
      guard: {
        checksPassed: 1,
        total: 3,
        miss: { procedureStepIndex: 1, reason: 'descriptor-ambiguous' },
      },
    })

    expect(step.planSource?.kind).toBe('procedure-replay')
    expect(
      step.planSource?.kind === 'procedure-replay' ? step.planSource.guard.miss?.reason : undefined,
    ).toBe('descriptor-ambiguous')
  })
})

// The masker is the product's own declared-secret SecretRedactor, the one a run threads.
describe('real step evidence is masked at rest', () => {
  const CREDENTIAL = 'zz-populated-secret-7f3a91c2'
  const EMAIL = 'qa-person@example.com'
  const STEP_TEXT = `Acknowledge the notice using ${CREDENTIAL}.`
  const PLANNED_ACTION: Action = {
    type: 'fill',
    ref: asRef('e1'),
    text: CREDENTIAL,
    clearMode: 'replace',
    submit: false,
  }
  const INTERPOLATED: InterpolatedVariable[] = [{ name: 'LOGIN_USER', value: EMAIL }]
  const SCREENSHOT_REF: ArtifactRef = { id: 'decision-0', sha: 'a'.repeat(64) }
  const ANNOTATION: ActionAnnotation = {
    kind: 'point',
    viewport: { width: 390, height: 844 },
    point: { x: 195, y: 222 },
  }

  function seededMask(): MaskFn {
    const redactor = new SecretRedactor(
      new SecretStore({ OPERATOR_TOKEN: CREDENTIAL, LOGIN_USER: EMAIL }),
    )
    return (text: string) => redactor.redactString(text)
  }

  function realEvidence(): StepEvidence {
    return {
      stepIndex: 0,
      stepText: STEP_TEXT,
      cacheStatus: 'miss',
      servedBrief: makeEmptyServedBrief(scope, 7),
      subActions: [
        {
          plan: `Type ${CREDENTIAL} into the field the notice names for ${EMAIL}`,
          plannedAction: PLANNED_ACTION,
          stateBefore: makeScreenState(),
          result: {
            success: false,
            error: `Cannot acknowledge: the notice names ${EMAIL} as contact, the operator credential ${CREDENTIAL} was refused`,
            data: { echoed: `server saw ${EMAIL}` },
            metadata: { header: `authorization ${CREDENTIAL}` },
            annotation: ANNOTATION,
          },
          decisionScreenshotRef: SCREENSHOT_REF,
        },
      ],
      verifierVerdict: { pass: false, reasoning: `verifier read ${EMAIL} in the notice` },
      interpolatedVariables: INTERPOLATED,
    }
  }

  function resultWithEvidence(evidence: StepEvidence): TestResult {
    return {
      name: 'checkout',
      filePath: 'checkout.test.ts',
      status: 'failed',
      duration: 1,
      steps: [{ name: evidence.stepText, status: 'failed', duration: 1, evidence }],
    }
  }

  function assembleOnce(mask: MaskFn): StepEvidence {
    const outcome = assemblePerTestOutcome(member, resultWithEvidence(realEvidence()), 'failed', {
      testIndex: 0,
      scope,
      buildOrdinal: 7,
      mask,
    })
    return outcome.steps[0]
  }

  function assembleEvidence(evidence: StepEvidence, mask: MaskFn): StepEvidence {
    const outcome = assemblePerTestOutcome(member, resultWithEvidence(evidence), 'failed', {
      testIndex: 0,
      scope,
      buildOrdinal: 7,
      mask,
    })
    return outcome.steps[0]
  }

  it('folds a PARTIAL value through unchanged instead of throwing — the totality it states', () => {
    // The schema declares `plan`, `result` and `reasoning` required, so a well-typed producer
    // never gets here. This fold transforms a value it did not construct, and its doc block
    // promises a partial one comes out as it went in rather than gaining an undefined-valued key
    // or throwing — a promise the next caller reads before deciding it is safe to reuse.
    const partial = {
      stepIndex: 0,
      stepText: STEP_TEXT,
      cacheStatus: 'miss',
      servedBrief: makeEmptyServedBrief(scope, 7),
      subActions: [{ plannedAction: PLANNED_ACTION, stateBefore: makeScreenState() }],
      verifierVerdict: { pass: false },
    } as unknown as StepEvidence

    const step = assembleEvidence(partial, seededMask())
    const subAction = step.subActions[0] as Partial<StepEvidence['subActions'][number]>

    // ABSENT, not undefined-valued: a key that survives as a hole reappears after a JSON round
    // trip as a field the consumer must now defend against.
    expect('plan' in subAction).toBe(false)
    expect('result' in subAction).toBe(false)
    expect('reasoning' in step.verifierVerdict).toBe(false)
    // What is present rides through untouched.
    expect(subAction.plannedAction).toEqual(PLANNED_ACTION)
    expect(step.stepText).toBe(STEP_TEXT)
  })

  it('pins MASKED_HANDOFF_NARRATION_FIELDS by value — a later edit reds by NAME, not only behaviourally', () => {
    expect(MASKED_HANDOFF_NARRATION_FIELDS).toEqual([
      'verifierVerdict.reasoning',
      'subActions[].plan',
      'subActions[].result.error',
      'subActions[].result.data',
      'subActions[].result.metadata',
    ])
  })

  it('masks the narration set through the run OWN MaskFn — one masker, no second detector', () => {
    const step = assembleOnce(seededMask())
    const subAction = step.subActions[0]

    expect(step.verifierVerdict.reasoning).toBe('verifier read [secret:LOGIN_USER] in the notice')
    expect(subAction.plan).toBe(
      'Type [secret:OPERATOR_TOKEN] into the field the notice names for [secret:LOGIN_USER]',
    )
    expect(subAction.result.error).toBe(
      'Cannot acknowledge: the notice names [secret:LOGIN_USER] as contact, the operator credential [secret:OPERATOR_TOKEN] was refused',
    )
    expect(subAction.result.data).toEqual({ echoed: 'server saw [secret:LOGIN_USER]' })
    expect(subAction.result.metadata).toEqual({ header: 'authorization [secret:OPERATOR_TOKEN]' })
  })

  it('leaves stepText, plannedAction and interpolatedVariables BYTE-IDENTICAL (the provenance carve-out)', () => {
    const step = assembleOnce(seededMask())

    expect(step.stepText).toBe(STEP_TEXT)
    expect(step.subActions[0].plannedAction).toEqual(PLANNED_ACTION)
    expect(step.interpolatedVariables).toEqual(INTERPOLATED)
    // the exact-match the emit fold depends on: the binding value is still findable in the action
    expect(JSON.stringify(step.subActions[0].plannedAction)).toContain(CREDENTIAL)
    expect(step.interpolatedVariables?.[0].value).toBe(EMAIL)
  })

  it('leaves the untouched-by-construction members deep-equal to the input', () => {
    const input = realEvidence()
    const step = assembleOnce(seededMask())
    const subAction = step.subActions[0]

    expect(subAction.stateBefore).toEqual(input.subActions[0].stateBefore)
    expect(subAction.result.success).toBe(false)
    expect(subAction.result.annotation).toEqual(ANNOTATION)
    expect(subAction.decisionScreenshotRef).toEqual(SCREENSHOT_REF)
    expect(step.servedBrief).toEqual(input.servedBrief)
  })

  it('is a FIXED POINT — assembling twice through the same context yields byte-identical steps', () => {
    const mask = seededMask()
    const first = assembleOnce(mask)
    const second = assemblePerTestOutcome(member, resultWithEvidence(first), 'failed', {
      testIndex: 0,
      scope,
      buildOrdinal: 7,
      mask,
    }).steps[0]

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('still round-trips through the one handoff guard — only string VALUES moved', () => {
    const config = {
      runId: 'run-mask' as RunId,
      scope,
      executionContext: 'local-headless',
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      buildOrdinal: 7,
      members: [member],
      executor: async () => resultWithoutEvidence(),
    } satisfies RunConfig
    const outcome = assemblePerTestOutcome(
      member,
      resultWithEvidence(realEvidence()),
      'failed',
      { testIndex: 0, scope, buildOrdinal: 7, mask: seededMask() },
    )

    const handoff = assembleHandoff(config, [outcome], 'failed', { startedAt: 1, endedAt: 2 })
    const reloaded = guardCompletedRunHandoff(JSON.parse(JSON.stringify(handoff)))

    expect(reloaded.tests[0].steps[0].subActions[0].result.error).toContain('[secret:LOGIN_USER]')
    expect(reloaded.tests[0].steps[0].stepText).toBe(STEP_TEXT)
  })
})
