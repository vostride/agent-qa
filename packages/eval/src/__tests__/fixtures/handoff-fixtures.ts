import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRecordId,
  asRef,
  asRunId,
  computeBriefDigest,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  CompletedRunHandoff,
  DeclaredModelProfile,
  ElementInfo,
  ModelCallRecord,
  PerTestOutcome,
  RecordedActionResult,
  ScreenState,
  ServedBrief,
  StepEvidence,
  SubActionEvidence,
  VerifierVerdict,
  WorkingMemoryEntry,
} from '@vostride/agent-qa-schema'

export type HandoffFixtureOverrides = Partial<CompletedRunHandoff>

export const FIXTURE_SCREENSHOT_SHA = 'a'.repeat(64)
export const FIXTURE_ARTIFACT_SHA = 'b'.repeat(64)

const TOOL_SCHEMA_DIGEST = 'c'.repeat(64)
const SUITE_CONFIG_DIGEST = 'd'.repeat(64)
const TEST_CONFIG_DIGEST = 'e'.repeat(64)

const scope = { tier: 'suite', key: 'checkout' } as const

const modelProfile: DeclaredModelProfile = {
  provider: 'openai-compatible',
  modelId: 'fixture-planner',
  vision: true,
  maxOutputTokens: 1_024,
  sampling: {
    temperature: 0,
    topP: 0.9,
    stop: ['<END>'],
    seed: 42,
  },
}

const callRecord: ModelCallRecord = {
  resolvedModelId: 'fixture-planner-2026-07-10',
  fingerprint: 'fp_fixture_001',
  effectiveMaxOutputTokens: 1_024,
  effectiveSampling: {
    temperature: 0,
    topP: 0.9,
    stop: ['<END>'],
    seed: 42,
  },
}

const workingMemory: WorkingMemoryEntry[] = [
  {
    key: 'checkout-email',
    value: '<EMAIL_0>',
    kind: 'extracted-value',
    provenance: 'observation',
    testIndex: 0,
    stepIndex: 0,
  },
]

function stampBrief(brief: Omit<ServedBrief, 'briefDigest'>): ServedBrief {
  const unstamped: ServedBrief = { ...brief, briefDigest: '' }
  return { ...unstamped, briefDigest: computeBriefDigest(unstamped) }
}

function makeServedBrief(asOfBuild: number): ServedBrief {
  return stampBrief({
    scope,
    asOfBuild,
    budget: 2_048,
    truncation: 'none',
    channel1: [
      {
        id: asRecordId('rec_checkout_button'),
        kind: 'fact',
        summary: 'The checkout button is named Continue',
        trust: 0.9,
        status: 'active',
        servedAsCanary: false,
        tier: 'product',
      },
    ],
    channel2: [
      {
        id: asRecordId('rec_checkout_flow'),
        detailLevel: 'summary',
        bodyDigest: 'f'.repeat(64),
      },
    ],
    channel3: [
      {
        id: asRecordId('rec_checkout_caution'),
        anchors: [{ t: 'el', role: 'button', name: 'continue', ordinal: 0 }],
        summary: 'Prefer the enabled Continue button',
      },
    ],
  })
}

function makeEmptyServedBrief(asOfBuild: number): ServedBrief {
  return stampBrief({
    scope,
    asOfBuild,
    budget: 0,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
  })
}

function element(
  refValue: string,
  role: string,
  name: string,
  x: number,
  hierarchy?: ElementInfo['hierarchy'],
): ElementInfo {
  return {
    ref: asRef(refValue),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    bounds: { x, y: 24, width: 120, height: 40 },
    center: { x: x + 60, y: 44 },
    state: {
      enabled: true,
      focused: false,
      visible: true,
      clickable: role === 'button',
    },
    labels: { ariaLabel: name },
    hierarchy,
    attributes: { 'data-fixture': refValue },
  }
}

function makeScreenState(timestamp: number): ScreenState {
  const rootRef = asRef('e-root')
  const firstContinueRef = asRef('e-continue-1')
  const secondContinueRef = asRef('e-continue-2')
  const statusRef = asRef('e-status')
  const elements = [
    element('e-root', 'main', 'Checkout', 0, {
      childRefs: [firstContinueRef, secondContinueRef, statusRef],
    }),
    element('e-continue-1', 'button', 'Continue', 24, { parentRef: rootRef }),
    element('e-continue-2', 'button', 'Continue', 168, { parentRef: rootRef }),
    element('e-status', 'status', 'Ready', 312, { parentRef: rootRef }),
  ]

  return {
    platform: 'web',
    tree: 'main Checkout\n  button Continue\n  button Continue\n  status Ready',
    elements,
    refMap: Object.fromEntries(
      elements.map((entry) => [
        entry.ref,
        {
          bounds: entry.bounds!,
          center: entry.center!,
          scrollContext: { offsetX: 0, offsetY: 0 },
        },
      ]),
    ) as ScreenState['refMap'],
    url: 'https://shop.example.test/checkout',
    timestamp,
    metadata: {
      captureMode: 'full',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      imageWidth: 1_280,
      imageHeight: 720,
      scroll: {
        offsetX: 0,
        offsetY: 0,
        contentWidth: 1_280,
        contentHeight: 1_440,
      },
    },
  }
}

function makeResult(success: boolean): RecordedActionResult {
  return {
    success,
    error: success ? undefined : 'recorded execution failure',
    data: { maskedAccount: '<EMAIL_0>' },
    metadata: { source: 'fixture' },
    annotation: {
      kind: 'point',
      viewport: { width: 1_280, height: 720 },
      point: {
        x: 84,
        y: 44,
        boundingBox: { x: 24, y: 24, width: 120, height: 40 },
      },
    },
  }
}

function liveSubAction(
  plan: string,
  action: SubActionEvidence['plannedAction'],
  timestamp: number,
  exchanges: NonNullable<SubActionEvidence['exchanges']>,
  success = true,
): SubActionEvidence {
  return {
    plan,
    plannedAction: action,
    stateBefore: makeScreenState(timestamp),
    result: makeResult(success),
    exchanges,
    callRecord: { ...callRecord },
  }
}

function cacheHitSubAction(timestamp: number): SubActionEvidence {
  return {
    plan: 'Replay the cached Continue decision',
    plannedAction: { type: 'click', ref: asRef('e-continue-2') },
    stateBefore: makeScreenState(timestamp),
    result: makeResult(true),
  }
}

function step(
  stepIndex: number,
  stepText: string,
  cacheStatus: StepEvidence['cacheStatus'],
  subActions: SubActionEvidence[],
  verdict: VerifierVerdict,
  servedBrief: ServedBrief = makeServedBrief(37),
): StepEvidence {
  return {
    stepIndex,
    stepText,
    cacheStatus,
    servedBrief,
    workingMemory: workingMemory.map((entry) => ({ ...entry, stepIndex })),
    modelProfile: { ...modelProfile, sampling: { ...modelProfile.sampling } },
    toolSchemaDigest: TOOL_SCHEMA_DIGEST,
    subActions,
    verifierVerdict: verdict,
    verifierIdentity: { provider: 'openai-compatible', modelId: 'fixture-verifier' },
  }
}

function makePassingTest(): PerTestOutcome {
  const liveExchange = {
    tool: 'inspect',
    args: { query: '<SECRET_0>', options: { includeHidden: false } },
    result: { text: 'masked result for <EMAIL_0>', refs: ['e-continue-1'] },
  }

  return {
    testId: 'checkout::happy-path',
    testName: 'Checkout happy path',
    filePath: 'tests/checkout/happy-path.test.ts',
    testIndex: 0,
    outcome: 'passed',
    steps: [
      step(
        0,
        'Click the first Continue button',
        'miss',
        [
          liveSubAction(
            'Choose the first enabled Continue control',
            { type: 'click', ref: asRef('e-continue-1') },
            1_725_000_000_100,
            [liveExchange],
          ),
        ],
        { pass: true, reasoning: 'The checkout advanced' },
      ),
      step(
        1,
        'Continue through the saved checkout state',
        'hit',
        [
          cacheHitSubAction(1_725_000_000_200),
          liveSubAction(
            'Confirm the follow-up state without auxiliary tools',
            { type: 'click', ref: asRef('e-continue-2') },
            1_725_000_000_300,
            [],
          ),
        ],
        { pass: true, reasoning: 'The follow-up state is visible' },
      ),
      step(
        2,
        'Record the synthesized terminal state',
        'bypass',
        [],
        { pass: true, reasoning: 'No action was required' },
        makeEmptyServedBrief(37),
      ),
    ],
  }
}

function makeFailingTest(): PerTestOutcome {
  const failedDecision = liveSubAction(
    'Attempt the recorded Continue action',
    { type: 'click', ref: asRef('e-continue-1') },
    1_725_000_001_100,
    [
      {
        tool: 'inspect',
        args: { query: 'checkout status' },
        result: { status: 'blocked' },
      },
    ],
    false,
  )
  const finalAssert = liveSubAction(
    'Assert that the URL reached the completion route',
    { type: 'assertValue', source: 'url', op: 'contains', expected: '/complete' },
    1_725_000_001_300,
    [],
    true,
  )

  const planningFailureStep = step(
    1,
    'Plan a recovery action',
    'bypass',
    [],
    { pass: false, reasoning: 'No recovery action was produced' },
  )
  planningFailureStep.planningFailure = {
    reason: 'tool-loop-exhausted',
    message: 'The masked planning turn exhausted its tool budget',
    exchanges: [
      {
        tool: 'inspect',
        args: { query: '<SECRET_0>' },
        result: { status: 'inconclusive' },
      },
    ],
    callRecord: { ...callRecord },
  }

  const assertStep = step(
    2,
    'Verify the checkout completion URL',
    'miss',
    [finalAssert],
    { pass: false, reasoning: 'The URL stayed on the checkout route' },
  )
  assertStep.assertOutcome = {
    source: 'url',
    op: 'contains',
    expected: '/complete',
    actual: '/checkout',
    passed: false,
  }
  assertStep.verdictSource = 'assert-value'

  return {
    testId: 'checkout::failure-path',
    testName: 'Checkout failure path',
    filePath: 'tests/checkout/failure-path.test.ts',
    testIndex: 1,
    outcome: 'failed',
    steps: [
      step(
        0,
        'Click Continue despite the blocked state',
        'miss',
        [failedDecision],
        { pass: false, reasoning: 'Continue remained blocked after execution' },
      ),
      planningFailureStep,
      assertStep,
    ],
  }
}

function makeBaseHandoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run / checkout suite 42'),
    scope,
    buildOrdinal: 37,
    executionContext: 'ci',
    aggregateVerdict: 'failed',
    configDigests: {
      suiteConfigDigest: SUITE_CONFIG_DIGEST,
      testConfigDigest: TEST_CONFIG_DIGEST,
    },
    startedAt: 1_725_000_000_000,
    endedAt: 1_725_000_002_000,
    tests: [makePassingTest(), makeFailingTest()],
  }
}

function omitOptionalInstrumentation(handoff: CompletedRunHandoff): CompletedRunHandoff {
  return {
    ...handoff,
    tests: handoff.tests.map((test) => ({
      ...test,
      steps: test.steps.map((currentStep) => {
        const {
          workingMemory: _workingMemory,
          modelProfile: _modelProfile,
          toolSchemaDigest: _toolSchemaDigest,
          verifierIdentity: _verifierIdentity,
          ...withoutStepInstrumentation
        } = currentStep
        void _workingMemory
        void _modelProfile
        void _toolSchemaDigest
        void _verifierIdentity

        const withoutOptionalSubActionFields = currentStep.subActions.map((subAction) => {
          const {
            callRecord: _callRecord,
            decisionScreenshotRef: _decisionScreenshotRef,
            artifactRefs: _artifactRefs,
            ...withoutCallRecord
          } = subAction
          void _callRecord
          void _decisionScreenshotRef
          void _artifactRefs
          const stateBefore = {
            ...withoutCallRecord.stateBefore,
            elements: withoutCallRecord.stateBefore.elements.map((entry) => {
              const { hierarchy: _hierarchy, ...withoutHierarchy } = entry
              void _hierarchy
              return withoutHierarchy
            }),
          }
          const { annotation: _annotation, ...result } = withoutCallRecord.result
          void _annotation
          return { ...withoutCallRecord, stateBefore, result }
        })

        const planningFailure = withoutStepInstrumentation.planningFailure
        const withoutPlanningCall = planningFailure === undefined
          ? undefined
          : {
              reason: planningFailure.reason,
              message: planningFailure.message,
              exchanges: planningFailure.exchanges,
            }

        return {
          ...withoutStepInstrumentation,
          subActions: withoutOptionalSubActionFields,
          ...(withoutPlanningCall === undefined ? {} : { planningFailure: withoutPlanningCall }),
        }
      }),
    })),
  }
}

function addArtifactRefs(handoff: CompletedRunHandoff): CompletedRunHandoff {
  const screenshot: ArtifactRef = {
    id: 'fixture-screenshot',
    sha: FIXTURE_SCREENSHOT_SHA,
  }
  const artifact: ArtifactRef = {
    id: 'fixture-accessibility-snapshot',
    sha: FIXTURE_ARTIFACT_SHA,
  }

  return {
    ...handoff,
    tests: handoff.tests.map((test) => ({
      ...test,
      steps: test.steps.map((currentStep) => ({
        ...currentStep,
        subActions: currentStep.subActions.map((subAction) =>
          subAction.exchanges === undefined
            ? subAction
            : {
                ...subAction,
                decisionScreenshotRef: { ...screenshot },
                artifactRefs: [{ ...artifact }],
              },
        ),
      })),
    })),
  }
}

export function makeV2Handoff(overrides: HandoffFixtureOverrides = {}): CompletedRunHandoff {
  return { ...makeBaseHandoff(), ...overrides }
}

export function makeDegradedV2Handoff(
  overrides: HandoffFixtureOverrides = {},
): CompletedRunHandoff {
  return { ...omitOptionalInstrumentation(makeBaseHandoff()), ...overrides }
}

export function makeArtifactRefV2Handoff(
  overrides: HandoffFixtureOverrides = {},
): CompletedRunHandoff {
  return { ...addArtifactRefs(makeBaseHandoff()), ...overrides }
}
