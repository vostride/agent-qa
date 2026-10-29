import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRef,
  asRunId,
  type CompletedRunHandoff,
  type ElementInfo,
  type ScreenState,
  type StepEvidence,
  type SubActionEvidence,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { parseProcedureTrajectorySeed, projectCurationCandidates } from '../emit-candidates.js'

const PAGE = 'https://shop.example/editor'

function element(ref: string, name: string): ElementInfo {
  return {
    ref: asRef(ref),
    role: 'button',
    name,
    nameNormalized: name.toLowerCase(),
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    state: { enabled: true, focused: false, visible: true, clickable: true },
    labels: {},
    attributes: {},
  }
}

function screen(elements: ElementInfo[]): ScreenState {
  return {
    platform: 'web',
    tree: elements.map((entry) => `${entry.role} ${entry.name}`).join('\n'),
    elements,
    refMap: Object.fromEntries(
      elements.map((entry) => [entry.ref, { bounds: entry.bounds!, center: entry.center! }]),
    ),
    url: PAGE,
    timestamp: 1_750_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1_280, contentHeight: 1_440 },
    },
  }
}

function step(stepIndex: number, stepText: string, subAction: SubActionEvidence): StepEvidence {
  return {
    stepIndex,
    stepText,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: 'storefront' },
      asOfBuild: 42,
      budget: 1_000,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'brief-digest',
    },
    subActions: [subAction],
    verifierVerdict: { pass: true, reasoning: 'step verified' },
  }
}

function healedRun(): CompletedRunHandoff {
  const prior = screen([element('e1', 'Delete'), element('e2', 'Save'), element('e3', 'Cancel')])
  const fresh = screen([
    element('e1', 'Banner'),
    element('e2', 'Delete'),
    element('e3', 'Save'),
    element('e4', 'Cancel'),
  ])
  const healed = {
    plan: 'Click Save',
    plannedAction: { type: 'click', ref: asRef('e2') },
    stateBefore: prior,
    stateAfter: fresh,
    result: { success: true },
    healedDispatch: { action: { type: 'click', ref: asRef('e3') }, stateBefore: fresh },
  } as SubActionEvidence
  const done = screen([element('e1', 'Done')])
  const finish: SubActionEvidence = {
    plan: 'Click Done',
    plannedAction: { type: 'click', ref: asRef('e1') },
    stateBefore: done,
    stateAfter: done,
    result: { success: true },
  }
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('r-dispatch-pair'),
    scope: { tier: 'product', key: 'storefront' },
    buildOrdinal: 42,
    executionContext: 'local-interactive',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests: [{
      testId: 'editor::healed-step',
      testName: 'Use a healed control then finish',
      testIndex: 0,
      outcome: 'passed',
      steps: [step(0, 'Save the record', healed), step(1, 'Click Done', finish)],
      filePath: 'editor.spec.yaml',
    }],
  }
}

describe('curation of a healed sub-action', () => {
  it('curation projects a healed sub-action from the pair it dispatched', () => {
    const candidates = projectCurationCandidates(healedRun())
    const [target] = candidates.filter((row) => row.kind === 'procedure')
    expect(target).toBeDefined()
    const seed = parseProcedureTrajectorySeed(target!.bodySeed)
    expect(seed?.steps[0]?.action?.targets).toEqual({
      ref: { ref: 'e3', role: 'button', nameNormalized: 'save', name: 'Save' },
    })
    expect(seed?.steps[0]?.pageRoute).toBe(PAGE)
  })
})
