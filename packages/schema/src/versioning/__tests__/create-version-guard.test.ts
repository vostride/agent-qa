import { describe, expect, it, vi } from 'vitest'

import {
  createVersionGuard,
  VersionGuardError,
} from '../create-version-guard'
import {
  guardCompletedRunHandoff,
  HandoffVersionError,
} from '../../handoff/load-completed-run-handoff'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  type CompletedRunHandoff,
} from '../../handoff/completed-run-handoff'
import type { PerTestOutcome } from '../../handoff/per-test-outcome'
import type { StepEvidence } from '../../handoff/step-evidence'

interface TestDocument {
  schemaVersion: number
  value: string
}

class CustomVersionError extends Error {
  readonly foundVersion: number
  readonly supportedVersion: number

  constructor(found: number, supported: number) {
    super(`custom ${found}/${supported}`)
    this.name = 'CustomVersionError'
    this.foundVersion = found
    this.supportedVersion = supported
  }
}

function makeCompleteHandoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: 'run-complete' as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop-web' },
    buildOrdinal: 42,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: {
      suiteConfigDigest: 'suite-digest',
      testConfigDigest: 'test-digest',
    },
    startedAt: 100,
    endedAt: 200,
    tests: [{
      testId: 'checkout-happy-1',
      testName: 'checkout happy path',
      filePath: 'suite/checkout.test.ts',
      testIndex: 0,
      outcome: 'passed',
      steps: [{
        stepIndex: 0,
        stepText: 'Click checkout',
        cacheStatus: 'miss',
        servedBrief: {
          scope: { tier: 'product', key: 'shop-web' },
          asOfBuild: 42,
          budget: 128,
          truncation: 'none',
          channel1: [],
          channel2: [],
          channel3: [],
          briefDigest: 'brief-digest',
        },
        subActions: [],
        verifierVerdict: { pass: true, reasoning: 'Observed checkout' },
      }],
    }],
  }
}

function mutateCompleteHandoff(
  mutate: (handoff: CompletedRunHandoff) => void,
): CompletedRunHandoff {
  const handoff = structuredClone(makeCompleteHandoff())
  mutate(handoff)
  return handoff
}

function omitHandoffField(field: keyof CompletedRunHandoff): CompletedRunHandoff {
  return mutateCompleteHandoff((handoff) => {
    delete (handoff as Partial<CompletedRunHandoff>)[field]
  })
}

function omitTestField(field: keyof PerTestOutcome): CompletedRunHandoff {
  return mutateCompleteHandoff((handoff) => {
    delete (handoff.tests[0] as Partial<PerTestOutcome>)[field]
  })
}

function omitStepField(field: keyof StepEvidence): CompletedRunHandoff {
  return mutateCompleteHandoff((handoff) => {
    delete (handoff.tests[0]!.steps[0] as Partial<StepEvidence>)[field]
  })
}

const PLAN_SOURCE_MISS_REASONS = [
  'descriptor-ambiguous',
  'descriptor-missing',
  'page-anchor-mismatch',
  'gate-refused',
  'parameter-unbound',
  'non-replayable-action',
] as const

function completeReplayPlanSource(): Record<string, unknown> {
  return {
    kind: 'procedure-replay',
    procedureId: 'proc-checkout',
    guard: { checksPassed: 3, total: 3 },
  }
}

const COMPLETE_ARTIFACT_SHA =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function completeRootCause(): Record<string, unknown> {
  return {
    class: 'environment',
    producer: 'deterministic-classifier',
    confidence: 0.9,
    evidence: {
      citedSteps: [0],
      citedAnchors: [{ t: 'error', message: 'environment broke' }],
      citedArtifacts: [{ id: 'artifact-0', sha: COMPLETE_ARTIFACT_SHA }],
      rationale: 'environment failure observed',
    },
    memoryMisdirectionRuledOut: true,
    perTest: 1,
  }
}

function completeSubActionEvidence(): Record<string, unknown> {
  return {
    plannedAction: { type: 'click', ref: 'checkout' },
    stateBefore: {
      url: 'https://shop.example/checkout',
      platform: 'web',
      elements: [{
        ref: 'checkout',
        role: 'button',
        name: 'Checkout',
        nameNormalized: 'checkout',
        state: { enabled: true, focused: false, visible: true },
        labels: { testId: 'checkout' },
        attributes: { type: 'submit' },
      }],
    },
  }
}

function withPlanSource(planSource: unknown): CompletedRunHandoff {
  return mutateCompleteHandoff((handoff) => {
    handoff.tests[0]!.steps[0]!.planSource =
      planSource as StepEvidence['planSource']
  })
}

function withRootCause(rootCause: unknown): CompletedRunHandoff {
  return mutateCompleteHandoff((handoff) => {
    handoff.tests[0]!.rootCause = rootCause as PerTestOutcome['rootCause']
  })
}

function withSubActions(subActions: unknown): CompletedRunHandoff {
  return mutateCompleteHandoff((handoff) => {
    handoff.tests[0]!.steps[0]!.subActions =
      subActions as StepEvidence['subActions']
  })
}

function withInterpolatedVariables(pairs: unknown): CompletedRunHandoff {
  return mutateCompleteHandoff((handoff) => {
    handoff.tests[0]!.steps[0]!.interpolatedVariables =
      pairs as StepEvidence['interpolatedVariables']
  })
}

function withChannel1(channel1: unknown): CompletedRunHandoff {
  return mutateCompleteHandoff((handoff) => {
    handoff.tests[0]!.steps[0]!.servedBrief.channel1 =
      channel1 as unknown as StepEvidence['servedBrief']['channel1']
  })
}

function mutatedSubAction(
  mutate: (subAction: Record<string, unknown>) => void,
): CompletedRunHandoff {
  const subAction = completeSubActionEvidence()
  mutate(subAction)
  return withSubActions([subAction])
}

function mutatedElement(
  mutate: (element: Record<string, unknown>) => void,
): CompletedRunHandoff {
  return mutatedSubAction((subAction) => {
    const stateBefore = subAction.stateBefore as Record<string, unknown>
    const elements = stateBefore.elements as Array<Record<string, unknown>>
    mutate(elements[0]!)
  })
}

function mutatedReplayPlanSource(
  mutate: (
    source: Record<string, unknown>,
    guard: Record<string, unknown>,
  ) => void,
): CompletedRunHandoff {
  const source = completeReplayPlanSource()
  mutate(source, source.guard as Record<string, unknown>)
  return withPlanSource(source)
}

function mutatedRootCause(
  mutate: (
    rootCause: Record<string, unknown>,
    evidence: Record<string, unknown>,
  ) => void,
): CompletedRunHandoff {
  const rootCause = completeRootCause()
  mutate(rootCause, rootCause.evidence as Record<string, unknown>)
  return withRootCause(rootCause)
}

describe('createVersionGuard', () => {
  it.each([null, undefined, 'document', 1])(
    'rejects non-object input %j with a document-naming TypeError',
    (value) => {
      const guard = createVersionGuard<TestDocument>({
        name: 'Doc',
        current: 2,
        migrations: {},
      })

      expect(() => guard(value)).toThrowError(TypeError)
      expect(() => guard(value)).toThrow('Doc must be an object')
    },
  )

  it.each([
    {},
    { schemaVersion: '1' },
    { schemaVersion: Number.NaN },
    { schemaVersion: Number.POSITIVE_INFINITY },
  ])('requires a finite numeric schemaVersion for %j', (value) => {
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: {},
    })

    expect(() => guard(value)).toThrowError(TypeError)
    expect(() => guard(value)).toThrow('Doc requires a numeric schemaVersion')
  })

  it('rejects newer documents with a typed VersionGuardError', () => {
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: {},
    })

    let thrown: unknown
    try {
      guard({ schemaVersion: 3, value: 'future' })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(VersionGuardError)
    const error = thrown as VersionGuardError
    expect(error.name).toBe('VersionGuardError')
    expect(error.message).toBe(
      'Doc schemaVersion 3 is not supported (this build supports 2)',
    )
    expect(error.documentName).toBe('Doc')
    expect(error.foundVersion).toBe(3)
    expect(error.supportedVersion).toBe(2)
  })

  it('walks a registered migration and passes it the original document', () => {
    const original = { schemaVersion: 1, value: 'before' }
    const migrated: TestDocument = { schemaVersion: 2, value: 'after' }
    const migration = vi.fn(() => migrated)
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: { 1: migration },
    })

    expect(guard(original)).toBe(migrated)
    expect(migration).toHaveBeenCalledOnce()
    expect(migration).toHaveBeenCalledWith(original)
  })

  it('rejects an older document when a migration step is missing', () => {
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: {},
    })

    expect(() => guard({ schemaVersion: 1, value: 'old' })).toThrowError(
      VersionGuardError,
    )

    try {
      guard({ schemaVersion: 1, value: 'old' })
    } catch (error) {
      expect(error).toMatchObject({
        documentName: 'Doc',
        foundVersion: 1,
        supportedVersion: 2,
      })
    }
  })

  it('casts a current-version document through unchanged', () => {
    const current: TestDocument = { schemaVersion: 2, value: 'current' }
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: {},
    })

    expect(guard(current)).toBe(current)
  })

  it('rejects a current-version document that fails structural validation', () => {
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: {},
      shape: () => false,
    })

    expect(() => guard({ schemaVersion: 2, value: 'invalid' })).toThrowError(TypeError)
    expect(() => guard({ schemaVersion: 2, value: 'invalid' })).toThrow(
      'Doc failed structural validation',
    )
  })

  it('returns a current-version document that passes structural validation', () => {
    const current: TestDocument = { schemaVersion: 2, value: 'current' }
    const shape = vi.fn(() => true)
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: {},
      shape,
    })

    expect(guard(current)).toBe(current)
    expect(shape).toHaveBeenCalledOnce()
    expect(shape).toHaveBeenCalledWith(current)
  })

  it('runs structural validation after the migration walk', () => {
    const migrated: TestDocument = { schemaVersion: 2, value: 'after' }
    const shape = vi.fn((value: unknown) => value === migrated)
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: { 1: () => migrated },
      shape,
    })

    expect(guard({ schemaVersion: 1, value: 'before' })).toBe(migrated)
    expect(shape).toHaveBeenCalledOnce()
    expect(shape).toHaveBeenCalledWith(migrated)
  })

  it('uses the configured error constructor for version failures', () => {
    const guard = createVersionGuard<TestDocument>({
      name: 'Doc',
      current: 2,
      migrations: {},
      error: CustomVersionError,
    })

    expect(() => guard({ schemaVersion: 3, value: 'future' })).toThrowError(
      CustomVersionError,
    )
    expect(() => guard({ schemaVersion: 1, value: 'old' })).toThrowError(
      CustomVersionError,
    )
  })
})

describe('guardCompletedRunHandoff factory instance compatibility', () => {
  it('preserves the HandoffVersionError name, message, and version fields', () => {
    const newer = CURRENT_HANDOFF_SCHEMA_VERSION + 1
    let thrown: unknown
    try {
      guardCompletedRunHandoff({ schemaVersion: newer })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HandoffVersionError)
    expect(thrown).toBeInstanceOf(VersionGuardError)
    expect(thrown).toMatchObject({
      name: 'HandoffVersionError',
      message: `CompletedRunHandoff schemaVersion ${newer} is not supported (this build supports ${CURRENT_HANDOFF_SCHEMA_VERSION})`,
      foundVersion: newer,
      supportedVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    })
  })

  const invalidHandoffs: Array<[string, unknown]> = [
    ['missing every root field after schemaVersion', { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION }],
    ['missing required root fields around an empty tests array', { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, tests: [] }],
    [
      'missing required root and member fields around an empty steps array',
      { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, tests: [{ steps: [] }] },
    ],
    ['non-array tests', { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, tests: {} }],
    ['null test member', { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, tests: [null] }],
    ['test member missing steps', { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, tests: [{}] }],
    ['non-array steps', { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, tests: [{ steps: {} }] }],
    ['null step member', { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, tests: [{ steps: [null] }] }],
    ['missing runId', omitHandoffField('runId')],
    ['missing scope', omitHandoffField('scope')],
    [
      'scope tier outside the union',
      mutateCompleteHandoff((handoff) => {
        handoff.scope.tier = 'workspace' as CompletedRunHandoff['scope']['tier']
      }),
    ],
    [
      'empty scope key',
      mutateCompleteHandoff((handoff) => {
        handoff.scope.key = ''
      }),
    ],
    ['missing buildOrdinal', omitHandoffField('buildOrdinal')],
    [
      'excludedFromOutcomes other than literal true',
      mutateCompleteHandoff((handoff) => {
        handoff.excludedFromOutcomes = false as unknown as true
      }),
    ],
    ['missing executionContext', omitHandoffField('executionContext')],
    [
      'executionContext outside the union',
      mutateCompleteHandoff((handoff) => {
        handoff.executionContext = 'laptop' as CompletedRunHandoff['executionContext']
      }),
    ],
    ['missing aggregateVerdict', omitHandoffField('aggregateVerdict')],
    [
      'aggregateVerdict outside the union',
      mutateCompleteHandoff((handoff) => {
        handoff.aggregateVerdict = 'skipped' as CompletedRunHandoff['aggregateVerdict']
      }),
    ],
    ['missing configDigests', omitHandoffField('configDigests')],
    [
      'non-string suiteConfigDigest',
      mutateCompleteHandoff((handoff) => {
        handoff.configDigests.suiteConfigDigest = 42 as unknown as string
      }),
    ],
    [
      'missing testConfigDigest',
      mutateCompleteHandoff((handoff) => {
        delete (handoff.configDigests as Partial<CompletedRunHandoff['configDigests']>)
          .testConfigDigest
      }),
    ],
    ['missing startedAt', omitHandoffField('startedAt')],
    ['missing endedAt', omitHandoffField('endedAt')],
    ['missing testId', omitTestField('testId')],
    ['missing testName', omitTestField('testName')],
    [
      'empty testName',
      mutateCompleteHandoff((handoff) => {
        handoff.tests[0]!.testName = ''
      }),
    ],
    ['missing filePath', omitTestField('filePath')],
    [
      'empty filePath',
      mutateCompleteHandoff((handoff) => {
        handoff.tests[0]!.filePath = ''
      }),
    ],
    ['missing testIndex', omitTestField('testIndex')],
    [
      'outcome outside the union',
      mutateCompleteHandoff((handoff) => {
        handoff.tests[0]!.outcome = 'exploded' as PerTestOutcome['outcome']
      }),
    ],
    ['missing steps', omitTestField('steps')],
    [
      'null rootCause',
      mutateCompleteHandoff((handoff) => {
        handoff.tests[0]!.rootCause = null as unknown as NonNullable<PerTestOutcome['rootCause']>
      }),
    ],
    ['step missing stepIndex', omitStepField('stepIndex')],
    ['step missing stepText', omitStepField('stepText')],
    ['step missing cacheStatus', omitStepField('cacheStatus')],
    [
      'cacheStatus outside the union',
      mutateCompleteHandoff((handoff) => {
        handoff.tests[0]!.steps[0]!.cacheStatus = 'stale' as StepEvidence['cacheStatus']
      }),
    ],
    ['step missing servedBrief', omitStepField('servedBrief')],
    [
      'servedBrief missing channel1',
      mutateCompleteHandoff((handoff) => {
        delete (handoff.tests[0]!.steps[0]!.servedBrief as Partial<StepEvidence['servedBrief']>)
          .channel1
      }),
    ],
    ['step missing subActions', omitStepField('subActions')],
    ['step missing verifierVerdict', omitStepField('verifierVerdict')],
    [
      'verifierVerdict pass is not boolean',
      mutateCompleteHandoff((handoff) => {
        handoff.tests[0]!.steps[0]!.verifierVerdict.pass = 'yes' as unknown as boolean
      }),
    ],
    [
      'verifierVerdict reasoning is not a string',
      mutateCompleteHandoff((handoff) => {
        handoff.tests[0]!.steps[0]!.verifierVerdict.reasoning = 42 as unknown as string
      }),
    ],
    [
      'planSource is null',
      mutateCompleteHandoff((handoff) => {
        handoff.tests[0]!.steps[0]!.planSource = null as unknown as NonNullable<StepEvidence['planSource']>
      }),
    ],
    [
      'procedure-replay planSource with no guard member (flipped former acceptance)',
      withPlanSource({ kind: 'procedure-replay', procedureId: 'proc-checkout' }),
    ],
    [
      'rootCause carrying only a class (flipped former acceptance)',
      withRootCause({ class: 'environment' }),
    ],
    [
      'planSource missing kind',
      mutatedReplayPlanSource((source) => {
        delete source.kind
      }),
    ],
    [
      'planSource kind outside the union',
      mutatedReplayPlanSource((source) => {
        source.kind = 'procedure-served'
      }),
    ],
    [
      'procedure-replay planSource missing procedureId',
      mutatedReplayPlanSource((source) => {
        delete source.procedureId
      }),
    ],
    [
      'procedure-replay planSource with an empty procedureId',
      mutatedReplayPlanSource((source) => {
        source.procedureId = ''
      }),
    ],
    [
      'planSource guard is not an object',
      mutatedReplayPlanSource((source) => {
        source.guard = 'complete'
      }),
    ],
    [
      'planSource guard missing checksPassed',
      mutatedReplayPlanSource((_source, guard) => {
        delete guard.checksPassed
      }),
    ],
    [
      'planSource guard total is a string',
      mutatedReplayPlanSource((_source, guard) => {
        guard.total = '3'
      }),
    ],
    [
      'planSource guard miss missing procedureStepIndex',
      mutatedReplayPlanSource((_source, guard) => {
        guard.miss = { reason: 'gate-refused' }
      }),
    ],
    [
      'planSource guard miss reason outside the union',
      mutatedReplayPlanSource((_source, guard) => {
        guard.miss = { procedureStepIndex: 1, reason: 'selector-drift' }
      }),
    ],
    [
      'planSource guard executionFailure is a bare object',
      mutatedReplayPlanSource((_source, guard) => {
        guard.executionFailure = {}
      }),
    ],
    [
      'planSource guard verifierRejection with a string procedureStepIndex',
      mutatedReplayPlanSource((_source, guard) => {
        guard.verifierRejection = { procedureStepIndex: '2' }
      }),
    ],
    [
      'procedure-replay planSource flow is not an object',
      mutatedReplayPlanSource((source) => {
        source.flow = 'cursor 0 of 2'
      }),
    ],
    [
      'procedure-replay planSource flow missing length',
      mutatedReplayPlanSource((source) => {
        source.flow = { cursor: 0 }
      }),
    ],
    [
      'procedure-replay planSource flow cursor is a string',
      mutatedReplayPlanSource((source) => {
        source.flow = { cursor: '0', length: 2 }
      }),
    ],
    [
      'procedure-hint planSource missing procedureId',
      withPlanSource({ kind: 'procedure-hint' }),
    ],
    [
      'procedure-hint planSource with a demotion outside the closed union',
      withPlanSource({
        kind: 'procedure-hint',
        procedureId: 'proc-checkout',
        demotion: 'body-missing',
      }),
    ],
    [
      'procedure-hint planSource with a numeric demotion',
      withPlanSource({ kind: 'procedure-hint', procedureId: 'proc-checkout', demotion: 3 }),
    ],
    [
      'procedure-hint planSource with a null demotion',
      withPlanSource({ kind: 'procedure-hint', procedureId: 'proc-checkout', demotion: null }),
    ],
    [
      'rootCause class outside the union',
      mutatedRootCause((rootCause) => {
        rootCause.class = 'network'
      }),
    ],
    [
      'rootCause producer outside the union',
      mutatedRootCause((rootCause) => {
        rootCause.producer = 'llm-judge'
      }),
    ],
    [
      'rootCause missing confidence',
      mutatedRootCause((rootCause) => {
        delete rootCause.confidence
      }),
    ],
    [
      'rootCause missing evidence',
      mutatedRootCause((rootCause) => {
        delete rootCause.evidence
      }),
    ],
    [
      'rootCause evidence citedSteps containing a non-number',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedSteps = [0, 'one']
      }),
    ],
    [
      'rootCause evidence citedAnchors containing null',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [null]
      }),
    ],
    [
      'rootCause evidence missing rationale',
      mutatedRootCause((_rootCause, evidence) => {
        delete evidence.rationale
      }),
    ],
    [
      'rootCause missing memoryMisdirectionRuledOut',
      mutatedRootCause((rootCause) => {
        delete rootCause.memoryMisdirectionRuledOut
      }),
    ],
    [
      'rootCause perTest is a string',
      mutatedRootCause((rootCause) => {
        rootCause.perTest = '1'
      }),
    ],
    [
      'rootCause attribution missing records',
      mutatedRootCause((rootCause) => {
        rootCause.attribution = { anchors: [] }
      }),
    ],
    [
      'rootCause subtype present on a non-test_bug class',
      mutatedRootCause((rootCause) => {
        rootCause.subtype = 'stale_selector'
      }),
    ],
    [
      'rootCause test_bug subtype outside the union',
      mutatedRootCause((rootCause) => {
        rootCause.class = 'test_bug'
        rootCause.subtype = 'flaky_selector'
      }),
    ],
    [
      'step subActions carrying a bare element object (flipped former acceptance)',
      withSubActions([{}]),
    ],
    [
      'step subActions carrying a numeric element (flipped former acceptance)',
      withSubActions([42]),
    ],
    [
      'step subActions element with a null stateBefore (flipped former acceptance)',
      withSubActions([{ stateBefore: null }]),
    ],
    [
      'servedBrief channel1 carrying a null line (flipped former acceptance)',
      withChannel1([null]),
    ],
    ['subActions element is an array', withSubActions([[]])],
    [
      'subActions element missing plannedAction beside a complete stateBefore',
      mutatedSubAction((subAction) => {
        delete subAction.plannedAction
      }),
    ],
    [
      'subActions element plannedAction is an array',
      mutatedSubAction((subAction) => {
        subAction.plannedAction = []
      }),
    ],
    [
      'subActions element missing stateBefore beside a complete plannedAction',
      mutatedSubAction((subAction) => {
        delete subAction.stateBefore
      }),
    ],
    [
      'subActions element stateBefore missing elements',
      mutatedSubAction((subAction) => {
        delete (subAction.stateBefore as Record<string, unknown>).elements
      }),
    ],
    [
      'subActions element stateBefore elements containing null',
      mutatedSubAction((subAction) => {
        ;(subAction.stateBefore as Record<string, unknown>).elements = [null]
      }),
    ],
    [
      'subActions element stateBefore elements containing a number',
      mutatedSubAction((subAction) => {
        ;(subAction.stateBefore as Record<string, unknown>).elements = [42]
      }),
    ],
    [
      'stateBefore elements member missing attributes',
      mutatedElement((element) => {
        delete element.attributes
      }),
    ],
    [
      'stateBefore elements member attributes is an array',
      mutatedElement((element) => {
        element.attributes = []
      }),
    ],
    [
      'stateBefore elements member missing labels',
      mutatedElement((element) => {
        delete element.labels
      }),
    ],
    [
      'subActions element grounding is a number',
      mutatedSubAction((subAction) => {
        subAction.grounding = 42
      }),
    ],
    [
      'subActions element grounding is an array',
      mutatedSubAction((subAction) => {
        subAction.grounding = []
      }),
    ],
    [
      'subActions element grounding attempts containing null',
      mutatedSubAction((subAction) => {
        subAction.grounding = { attempts: [null] }
      }),
    ],
    [
      'subActions element grounding attempts is a string',
      mutatedSubAction((subAction) => {
        subAction.grounding = { attempts: 'oops' }
      }),
    ],
    [
      'subActions element grounding attempts is a number',
      mutatedSubAction((subAction) => {
        subAction.grounding = { attempts: 42 }
      }),
    ],
    [
      'subActions element grounding attempts containing an array member',
      mutatedSubAction((subAction) => {
        subAction.grounding = { attempts: [[]] }
      }),
    ],
    [
      'stateBefore elements member with a numeric role',
      mutatedElement((element) => {
        element.role = 42
      }),
    ],
    [
      'stateBefore elements member with a numeric nameNormalized',
      mutatedElement((element) => {
        element.nameNormalized = 42
      }),
    ],
    [
      'stateBefore elements member attributes with a numeric selector',
      mutatedElement((element) => {
        element.attributes = { selector: 42 }
      }),
    ],
    [
      'stateBefore elements member labels with a numeric testId',
      mutatedElement((element) => {
        element.attributes = {}
        element.labels = { testId: 42 }
      }),
    ],
    [
      'subActions element stateBefore with a numeric url',
      mutatedSubAction((subAction) => {
        ;(subAction.stateBefore as Record<string, unknown>).url = 42
      }),
    ],
    [
      'subActions element stateAfter with a numeric url',
      mutatedSubAction((subAction) => {
        subAction.stateAfter = { url: 42 }
      }),
    ],
    [
      'subActions element stateAfter is a number',
      mutatedSubAction((subAction) => {
        subAction.stateAfter = 42
      }),
    ],
    ['servedBrief channel1 carrying a numeric line', withChannel1([42])],
    ['servedBrief channel1 carrying an array line', withChannel1([[]])],
    [
      'rootCause evidence citedAnchors member without a discriminant',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{}]
      }),
    ],
    [
      'rootCause evidence citedAnchors page anchor missing route',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{ t: 'page' }]
      }),
    ],
    [
      'rootCause evidence citedAnchors page anchor with a numeric route',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{ t: 'page', route: 7 }]
      }),
    ],
    [
      'rootCause evidence citedAnchors member with an unknown kind',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{ t: 'unknown-kind' }]
      }),
    ],
    [
      'rootCause evidence citedAnchors member is an array',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [[]]
      }),
    ],
    [
      'rootCause evidence citedAnchors el anchor missing name',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{ t: 'el', role: 'button' }]
      }),
    ],
    [
      'rootCause evidence citedAnchors platform anchor outside the literal union',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{ t: 'platform', platform: 'desktop' }]
      }),
    ],
    [
      'rootCause evidence citedArtifacts member with the legacy artifactId shape',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedArtifacts = [{ artifactId: 'artifact-0' }]
      }),
    ],
    [
      'rootCause evidence citedArtifacts member missing sha',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedArtifacts = [{ id: 'artifact-0' }]
      }),
    ],
    [
      'rootCause evidence citedArtifacts member is an array',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedArtifacts = [[]]
      }),
    ],
    [
      'rootCause evidence citedAnchors el anchor with a string ordinal',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [
          { t: 'el', role: 'button', name: 'checkout', ordinal: '1' },
        ]
      }),
    ],
    [
      'rootCause evidence citedAnchors flow anchor missing name',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{ t: 'flow' }]
      }),
    ],
    [
      'rootCause evidence citedAnchors selector anchor missing literal',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{ t: 'selector' }]
      }),
    ],
    [
      'rootCause evidence citedAnchors error anchor missing message',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [{ t: 'error' }]
      }),
    ],
    [
      'rootCause evidence citedArtifacts member with a numeric id',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedArtifacts = [{ id: 7, sha: COMPLETE_ARTIFACT_SHA }]
      }),
    ],
    // 381-41 (G-381-3): interpolatedVariables is consumer-dereferenced by the
    // procedure-extraction emit fold — it applies string equality to `value` and copies
    // `name` verbatim, so both must be strings on every admitted member.
    [
      'step interpolatedVariables is a number',
      withInterpolatedVariables(42),
    ],
    [
      'step interpolatedVariables containing a string member',
      withInterpolatedVariables(['PROBE_USER']),
    ],
    [
      'step interpolatedVariables containing an array member',
      withInterpolatedVariables([[]]),
    ],
    [
      'step interpolatedVariables member with a numeric value',
      withInterpolatedVariables([{ name: 'PROBE_USER', value: 42 }]),
    ],
    [
      'step interpolatedVariables member missing name',
      withInterpolatedVariables([{ value: 'qa.user@example.com' }]),
    ],
    [
      'step interpolatedVariables member missing value',
      withInterpolatedVariables([{ name: 'PROBE_USER' }]),
    ],
  ]

  it.each(invalidHandoffs)('rejects a structurally unsafe current-version handoff: %s', (_label, handoff) => {
    expect(() => guardCompletedRunHandoff(handoff)).toThrowError(TypeError)
    expect(() => guardCompletedRunHandoff(handoff)).toThrow(
      'CompletedRunHandoff failed structural validation',
    )
  })

  const complete = makeCompleteHandoff()
  const emptyTests = mutateCompleteHandoff((handoff) => {
    handoff.tests = []
  })
  const emptySteps = mutateCompleteHandoff((handoff) => {
    handoff.tests[0]!.steps = []
  })

  it.each([
    ['complete DTO', complete],
    ['complete DTO with tests: []', emptyTests],
    ['complete member with steps: []', emptySteps],
  ] as const)('accepts a complete current-version handoff: %s', (_label, handoff) => {
    expect(guardCompletedRunHandoff(handoff)).toBe(handoff)
  })

  const acceptedNestedBlocks: Array<[string, CompletedRunHandoff]> = [
    ['complete DTO with neither optional block', makeCompleteHandoff()],
    [
      'procedure-hint planSource',
      withPlanSource({ kind: 'procedure-hint', procedureId: 'proc-checkout' }),
    ],
    ...(['body-unreadable', 'body-unparseable', 'body-empty'] as const).map(
      (demotion): [string, CompletedRunHandoff] => [
        `procedure-hint planSource demoted with ${demotion}`,
        withPlanSource({ kind: 'procedure-hint', procedureId: 'proc-checkout', demotion }),
      ],
    ),
    [
      'procedure-replay planSource with a bare complete guard',
      withPlanSource(completeReplayPlanSource()),
    ],
    ...PLAN_SOURCE_MISS_REASONS.map((reason): [string, CompletedRunHandoff] => [
      `procedure-replay guard miss with reason ${reason}`,
      mutatedReplayPlanSource((_source, guard) => {
        guard.checksPassed = 1
        guard.miss = { procedureStepIndex: 1, reason }
      }),
    ]),
    [
      'procedure-replay guard with executionFailure',
      mutatedReplayPlanSource((_source, guard) => {
        guard.executionFailure = { procedureStepIndex: 1 }
      }),
    ],
    [
      'procedure-replay guard with verifierRejection',
      mutatedReplayPlanSource((_source, guard) => {
        guard.verifierRejection = { procedureStepIndex: 2 }
      }),
    ],
    [
      'procedure-replay planSource with a well-formed flow cursor',
      mutatedReplayPlanSource((source) => {
        source.flow = { cursor: 1, length: 2 }
      }),
    ],
    [
      'environment rootCause with empty evidence arrays',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedSteps = []
        evidence.citedAnchors = []
        evidence.citedArtifacts = []
      }),
    ],
    [
      'test_bug rootCause with a valid subtype',
      mutatedRootCause((rootCause) => {
        rootCause.class = 'test_bug'
        rootCause.subtype = 'stale_selector'
      }),
    ],
    [
      'timeout rootCause with attribution present',
      mutatedRootCause((rootCause) => {
        rootCause.class = 'timeout'
        rootCause.attribution = { records: [], anchors: [] }
      }),
    ],
    [
      'fully populated subActions element',
      withSubActions([completeSubActionEvidence()]),
    ],
    [
      'subActions element stateBefore without url and platform',
      mutatedSubAction((subAction) => {
        const stateBefore = subAction.stateBefore as Record<string, unknown>
        delete stateBefore.url
        delete stateBefore.platform
      }),
    ],
    [
      'subActions element stateBefore with empty elements',
      mutatedSubAction((subAction) => {
        ;(subAction.stateBefore as Record<string, unknown>).elements = []
      }),
    ],
    [
      'subActions element stateAfter with honest navigation url',
      mutatedSubAction((subAction) => {
        subAction.stateAfter = {
          url: 'https://shop.example/confirmation',
          platform: 'web',
          elements: [],
        }
      }),
    ],
    [
      'subActions element stateAfter without url',
      mutatedSubAction((subAction) => {
        subAction.stateAfter = { platform: 'web', elements: [] }
      }),
    ],
    [
      'complete subActions element without grounding (absence legal)',
      mutatedSubAction((subAction) => {
        delete subAction.grounding
      }),
    ],
    [
      'subActions element grounding with empty attempts (emptiness distinct from malformed)',
      mutatedSubAction((subAction) => {
        subAction.grounding = {
          descriptor: { role: 'button', name: 'Checkout' },
          attempts: [],
        }
      }),
    ],
    [
      'subActions element grounding with one complete resolved attempt',
      mutatedSubAction((subAction) => {
        subAction.grounding = {
          descriptor: { role: 'button', name: 'Checkout' },
          attempts: [
            { stage: 'ref', outcome: 'resolved', resolvedRef: 'checkout' },
          ],
        }
      }),
    ],
    [
      'servedBrief channel1 with a plain well-formed line',
      withChannel1([{ id: 'candidate-checkout', servedAsCanary: true }]),
    ],
    [
      'rootCause citedAnchors carrying every anchor kind',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedAnchors = [
          { t: 'page', route: '/checkout' },
          { t: 'flow', name: 'checkout' },
          { t: 'el', role: 'button', name: 'checkout' },
          { t: 'el', role: 'button', name: 'checkout', ordinal: 1 },
          { t: 'platform', platform: 'web' },
          { t: 'selector', literal: '#checkout' },
          { t: 'error', message: 'boom' },
        ]
      }),
    ],
    [
      'step interpolatedVariables absent (the additive-optional base)',
      mutateCompleteHandoff((handoff) => {
        delete handoff.tests[0]!.steps[0]!.interpolatedVariables
      }),
    ],
    [
      'step interpolatedVariables empty (emptiness distinct from malformed)',
      withInterpolatedVariables([]),
    ],
    [
      'step interpolatedVariables with a well-formed email-valued pair',
      withInterpolatedVariables([{ name: 'PROBE_USER', value: 'qa.user@example.com' }]),
    ],
    [
      'step interpolatedVariables with several well-formed pairs',
      withInterpolatedVariables([
        { name: 'PROBE_USER', value: 'qa.user@example.com' },
        { name: 'PROBE_API_TOKEN', value: 'tok-live-9f3a2b' },
      ]),
    ],
    [
      'rootCause citedArtifacts ref with evidenceIncomplete present',
      mutatedRootCause((_rootCause, evidence) => {
        evidence.citedArtifacts = [{
          id: 'artifact-0',
          sha: COMPLETE_ARTIFACT_SHA,
          evidenceIncomplete: true,
        }]
      }),
    ],
  ]

  it.each(acceptedNestedBlocks)(
    'accepts a complete nested optional block: %s',
    (_label, handoff) => {
      expect(guardCompletedRunHandoff(handoff)).toBe(handoff)
    },
  )
})
