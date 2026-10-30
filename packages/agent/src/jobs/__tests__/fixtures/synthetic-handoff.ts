// One parameterizable substrate, so no suite mints a second fixture vocabulary.

import type {
  ArtifactRef,
  CompletedRunHandoff,
  ElementInfo,
  PerTestOutcome,
  ScreenState,
  ServedBrief,
  ServedRetrievalTraceV1,
  StepEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import { asRef, asRunId, CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

export interface SyntheticHandoffOptions {
  readonly runId?: string
  /** Failed member tests WITH one captured step each (quotable evidence, shared anchor). */
  readonly failureCount?: number
  /** Failed member tests with ZERO captured steps — the suite-bootstrap posture. */
  readonly steplessFailureCount?: number
  /** Clean passes appended after the failures; they never receive a verdict. */
  readonly passedCount?: number
  /** The one element every stepped failure exercised. */
  readonly sharedAnchor?: { readonly role: string; readonly name: string }
  /** The sub-action error text — the first thing the template author quotes. */
  readonly evidenceText?: string
  /** The verifier's reasoning — the quote fallback when no sub-action error exists. */
  readonly verifierReasoning?: string
  /** The route every stepped failure's screen carried (the page anchor). */
  readonly route?: string
  /**
   * A persisted deterministic verdict for the stepped failure at this index, or undefined
   * for the floor's minted `unknown`. Ranges over stepped failures only.
   */
  readonly rootCauseFor?: (failureIndex: number) => Verdict | undefined
  /** The run's build ordinal; prior-build history selects strictly below it. */
  readonly buildOrdinal?: number
  /** Passing steps before each stepped failure's failing step. */
  readonly passingStepsBefore?: number
  /** Passing steps after each stepped failure's failing step. */
  readonly passingStepsAfter?: number
  // One sub-action per screenshot ref; absent leaves a single sub-action with no ref.
  readonly decisionScreenshotRefs?: readonly ArtifactRef[]
  /** A serve-time retrieval trace attached to the failing step. */
  readonly retrievalTrace?: ServedRetrievalTraceV1
}

function servedBrief(): ServedBrief {
  return {
    scope: { tier: 'product', key: 'synthetic' },
    asOfBuild: 1,
    budget: 0,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: 'synthetic-brief-digest',
  }
}

function sharedElement(role: string, name: string): ElementInfo {
  return {
    ref: asRef('e1'),
    role,
    name,
    nameNormalized: name.trim().toLowerCase(),
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

function screenState(element: ElementInfo, route: string): ScreenState {
  return {
    platform: 'web',
    tree: '',
    elements: [element],
    refMap: {},
    url: route,
    timestamp: 1,
    metadata: {
      coordSpace: 'viewport',
      viewportWidth: 1280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
      captureMode: 'textOnly',
    },
  }
}

function failingStep(options: {
  readonly stepIndex: number
  readonly element: ElementInfo
  readonly route: string
  readonly evidenceText: string
  readonly verifierReasoning: string
  readonly decisionScreenshotRefs?: readonly ArtifactRef[]
  readonly retrievalTrace?: ServedRetrievalTraceV1
}): StepEvidence {
  const base = {
    plan: `click ${options.element.name}`,
    plannedAction: { type: 'click', ref: options.element.ref } as const,
    stateBefore: screenState(options.element, options.route),
  }
  const refs = options.decisionScreenshotRefs ?? []
  const subActions =
    refs.length === 0
      ? [{ ...base, result: { success: false, error: options.evidenceText } }]
      : refs.map((ref, index) => ({
          ...base,
          result:
            index === 0
              ? { success: false, error: options.evidenceText }
              : { success: false as const },
          decisionScreenshotRef: ref,
        }))
  return {
    stepIndex: options.stepIndex,
    stepText: `click the ${options.element.name} button`,
    cacheStatus: 'miss',
    servedBrief: servedBrief(),
    ...(options.retrievalTrace === undefined ? {} : { retrievalTrace: options.retrievalTrace }),
    subActions,
    verifierVerdict: { pass: false, reasoning: options.verifierReasoning },
  }
}

/** A verifier-passed neighbor step. */
function passingStep(options: {
  readonly stepIndex: number
  readonly element: ElementInfo
  readonly route: string
}): StepEvidence {
  return {
    stepIndex: options.stepIndex,
    stepText: `neighbor step ${options.stepIndex}`,
    cacheStatus: 'miss',
    servedBrief: servedBrief(),
    subActions: [
      {
        plan: `observe step ${options.stepIndex}`,
        plannedAction: { type: 'click', ref: options.element.ref },
        stateBefore: screenState(options.element, options.route),
        result: { success: true },
      },
    ],
    verifierVerdict: { pass: true, reasoning: `neighbor step ${options.stepIndex} verified` },
  }
}

// Members run stepped failures, step-less failures, then passes; stepped ones share one anchor.
export function buildSyntheticHandoff(
  options: SyntheticHandoffOptions = {},
): CompletedRunHandoff {
  const {
    runId = 'run-synthetic',
    failureCount = 1,
    steplessFailureCount = 0,
    passedCount = 0,
    sharedAnchor = { role: 'button', name: 'Submit' },
    evidenceText = 'Error: element "Submit" not found',
    verifierReasoning = 'the submit button never appeared on the checkout screen',
    route = '/checkout',
    rootCauseFor = () => undefined,
    buildOrdinal = 1,
    passingStepsBefore = 0,
    passingStepsAfter = 0,
    decisionScreenshotRefs,
    retrievalTrace,
  } = options

  const element = sharedElement(sharedAnchor.role, sharedAnchor.name)
  const tests: PerTestOutcome[] = []

  for (let index = 0; index < failureCount; index += 1) {
    const rootCause = rootCauseFor(index)
    const steps: StepEvidence[] = []
    for (let before = 0; before < passingStepsBefore; before += 1) {
      steps.push(passingStep({ stepIndex: steps.length, element, route }))
    }
    steps.push(
      failingStep({
        stepIndex: steps.length,
        element,
        route,
        evidenceText,
        verifierReasoning,
        decisionScreenshotRefs,
        retrievalTrace,
      }),
    )
    for (let after = 0; after < passingStepsAfter; after += 1) {
      steps.push(passingStep({ stepIndex: steps.length, element, route }))
    }
    tests.push({
      testId: `t_failed_${index}`,
      testName: `stepped failure ${index}`,
      filePath: `tests/failed-${index}.yaml`,
      testIndex: tests.length,
      outcome: 'failed',
      steps,
      ...(rootCause === undefined ? {} : { rootCause }),
    })
  }

  for (let index = 0; index < steplessFailureCount; index += 1) {
    tests.push({
      testId: `t_stepless_${index}`,
      testName: `step-less failure ${index}`,
      filePath: `tests/stepless-${index}.yaml`,
      testIndex: tests.length,
      outcome: 'failed',
      steps: [],
    })
  }

  for (let index = 0; index < passedCount; index += 1) {
    tests.push({
      testId: `t_passed_${index}`,
      testName: `clean pass ${index}`,
      filePath: `tests/passed-${index}.yaml`,
      testIndex: tests.length,
      outcome: 'passed',
      steps: [],
    })
  }

  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'synthetic' },
    buildOrdinal,
    executionContext: 'local-headless',
    aggregateVerdict: failureCount + steplessFailureCount > 0 ? 'failed' : 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests,
  }
}
