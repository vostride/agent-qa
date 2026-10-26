import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRef,
  asRunId,
  computeBriefDigest,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  CompletedRunHandoff,
  ScreenState,
  ServedBrief,
  StepEvidence,
} from '@vostride/agent-qa-schema'

export const LOCAL_FIXTURE_RUN_ID = 'run / eval-local standalone'
export const LOCAL_FIXTURE_TEST_ID = 'eval-local::standalone'
export const LOCAL_FIXTURE_BLOB_SHA =
  'd9113d37fe29084657c462ac5628ddd56519aeafad8883092a2596075878cbee'
export const LOCAL_FIXTURE_BLOB_BYTES = Uint8Array.from([
  97, 103, 101, 110, 116, 45, 113, 97, 32, 101, 118, 97, 108, 45, 108, 111, 99, 97, 108,
  32, 102, 105, 120, 116, 117, 114, 101, 32, 98, 108, 111, 98, 10,
])

const scope = { tier: 'suite', key: 'eval-local' } as const
const buttonRef = asRef('e-continue')

const DEFAULT_SCREENSHOT_REF: ArtifactRef = {
  id: 'eval-local-fixture-screenshot',
  sha: LOCAL_FIXTURE_BLOB_SHA,
}

function emptyBrief(): ServedBrief {
  const unstamped: ServedBrief = {
    scope,
    asOfBuild: 11,
    budget: 0,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: '',
  }
  return { ...unstamped, briefDigest: computeBriefDigest(unstamped) }
}

function screenState(timestamp: number): ScreenState {
  const bounds = { x: 24, y: 32, width: 160, height: 44 }
  const center = { x: 104, y: 54 }
  return {
    platform: 'web',
    tree: 'button Continue',
    elements: [
      {
        ref: buttonRef,
        role: 'button',
        name: 'Continue',
        nameNormalized: 'continue',
        bounds,
        center,
        state: { enabled: true, focused: false, visible: true, clickable: true },
        labels: { ariaLabel: 'Continue' },
        attributes: { 'data-fixture': 'continue' },
      },
    ],
    refMap: {
      [buttonRef]: {
        bounds,
        center,
        scrollContext: { offsetX: 0, offsetY: 0 },
      },
    } as ScreenState['refMap'],
    url: 'https://example.test/checkout',
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
        contentHeight: 720,
      },
    },
  }
}

function step(
  stepIndex: number,
  cacheStatus: StepEvidence['cacheStatus'],
  live: boolean,
  screenshotRef: ArtifactRef | null | undefined,
): StepEvidence {
  const resolvedRef = screenshotRef === undefined ? DEFAULT_SCREENSHOT_REF : screenshotRef
  return {
    stepIndex,
    stepText: live ? 'Click Continue' : 'Replay Continue from cache',
    cacheStatus,
    servedBrief: emptyBrief(),
    modelProfile: {
      provider: 'openai-compatible',
      modelId: 'eval-local-fixture-planner',
      vision: true,
      maxOutputTokens: 512,
      sampling: { temperature: 0 },
    },
    toolSchemaDigest: 'c'.repeat(64),
    subActions: [
      {
        plan: live ? 'Use the recorded Continue button' : 'Use the cached Continue decision',
        plannedAction: { type: 'click', ref: buttonRef },
        stateBefore: screenState(1_725_000_000_100 + stepIndex),
        result: {
          success: true,
          annotation: {
            kind: 'point',
            viewport: { width: 1_280, height: 720 },
            point: {
              x: 104,
              y: 54,
              boundingBox: { x: 24, y: 32, width: 160, height: 44 },
            },
          },
        },
        ...(live
          ? {
              exchanges: [],
              ...(resolvedRef === null ? {} : { decisionScreenshotRef: resolvedRef }),
              callRecord: {
                resolvedModelId: 'eval-local-fixture-planner-2026-07-10',
                fingerprint: 'fp_eval_local_fixture',
                effectiveMaxOutputTokens: 512,
                effectiveSampling: { temperature: 0 },
              },
            }
          : {}),
      },
    ],
    verifierVerdict: { pass: true, reasoning: 'The recorded state advanced' },
    verifierIdentity: {
      provider: 'openai-compatible',
      modelId: 'eval-local-fixture-verifier',
    },
  }
}

export function makeLocalV2Handoff(
  overrides: Partial<CompletedRunHandoff> = {},
  screenshotRef?: ArtifactRef | null,
): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(LOCAL_FIXTURE_RUN_ID),
    scope,
    buildOrdinal: 11,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: {
      suiteConfigDigest: 'd'.repeat(64),
      testConfigDigest: 'e'.repeat(64),
    },
    startedAt: 1_725_000_000_000,
    endedAt: 1_725_000_001_000,
    tests: [
      {
        testId: LOCAL_FIXTURE_TEST_ID,
        testName: 'Local handoff fixture test',
        filePath: 'tests/local-fixture.test.ts',
        testIndex: 0,
        outcome: 'passed',
        steps: [step(0, 'miss', true, screenshotRef), step(1, 'hit', false, undefined)],
      },
    ],
    ...overrides,
  }
}
